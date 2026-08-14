"use strict";

var PLY_TYPES = {
  char: { size: 1, read: "getInt8" },
  int8: { size: 1, read: "getInt8" },
  uchar: { size: 1, read: "getUint8" },
  uint8: { size: 1, read: "getUint8" },
  short: { size: 2, read: "getInt16" },
  int16: { size: 2, read: "getInt16" },
  ushort: { size: 2, read: "getUint16" },
  uint16: { size: 2, read: "getUint16" },
  int: { size: 4, read: "getInt32" },
  int32: { size: 4, read: "getInt32" },
  uint: { size: 4, read: "getUint32" },
  uint32: { size: 4, read: "getUint32" },
  float: { size: 4, read: "getFloat32" },
  float32: { size: 4, read: "getFloat32" },
  double: { size: 8, read: "getFloat64" },
  float64: { size: 8, read: "getFloat64" },
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function findHeaderEnd(bytes) {
  var marker = [101, 110, 100, 95, 104, 101, 97, 100, 101, 114];

  for (var index = 0; index <= bytes.length - marker.length; index += 1) {
    var matches = true;
    for (var markerIndex = 0; markerIndex < marker.length; markerIndex += 1) {
      if (bytes[index + markerIndex] !== marker[markerIndex]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      var headerEnd = index + marker.length;
      if (bytes[headerEnd] === 13) headerEnd += 1;
      if (bytes[headerEnd] === 10) headerEnd += 1;
      return headerEnd;
    }
  }

  throw new Error("Invalid PLY file: end_header was not found");
}

function readProperty(dataView, byteOffset, property) {
  var type = PLY_TYPES[property.type];
  return dataView[type.read](byteOffset + property.offset, true);
}

function robustPointBounds(positions, pointCount, minimum, maximum) {
  var binCount = 2048;
  var trimFraction = 0.005;
  var histograms = [
    new Uint32Array(binCount),
    new Uint32Array(binCount),
    new Uint32Array(binCount),
  ];
  var spans = [
    maximum[0] - minimum[0],
    maximum[1] - minimum[1],
    maximum[2] - minimum[2],
  ];

  for (var pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    var offset = pointIndex * 3;
    for (var axis = 0; axis < 3; axis += 1) {
      if (spans[axis] <= 0) {
        histograms[axis][0] += 1;
        continue;
      }
      var normalized = (positions[offset + axis] - minimum[axis]) / spans[axis];
      var bin = clamp(Math.floor(normalized * binCount), 0, binCount - 1);
      histograms[axis][bin] += 1;
    }
  }

  var lowerTarget = Math.floor(pointCount * trimFraction);
  var upperTarget = Math.ceil(pointCount * (1 - trimFraction));
  var robustMinimum = minimum.slice();
  var robustMaximum = maximum.slice();

  histograms.forEach(function (histogram, axis) {
    if (spans[axis] <= 0) return;
    var cumulative = 0;
    var lowerBin = 0;
    var upperBin = binCount - 1;

    for (var bin = 0; bin < binCount; bin += 1) {
      cumulative += histogram[bin];
      if (cumulative > lowerTarget) {
        lowerBin = bin;
        break;
      }
    }

    cumulative = 0;
    for (var upperIndex = 0; upperIndex < binCount; upperIndex += 1) {
      cumulative += histogram[upperIndex];
      if (cumulative >= upperTarget) {
        upperBin = upperIndex;
        break;
      }
    }

    robustMinimum[axis] = minimum[axis] + (spans[axis] * lowerBin) / binCount;
    robustMaximum[axis] =
      minimum[axis] + (spans[axis] * (upperBin + 1)) / binCount;
  });

  return { minimum: robustMinimum, maximum: robustMaximum };
}

function parseBinaryPly(arrayBuffer) {
  var bytes = new Uint8Array(arrayBuffer);
  var headerEnd = findHeaderEnd(bytes);
  var header = new TextDecoder("ascii").decode(bytes.subarray(0, headerEnd));
  var lines = header.split(/\r?\n/);
  var vertexCount = 0;
  var vertexStride = 0;
  var inVertexElement = false;
  var properties = [];

  lines.forEach(function (line) {
    var parts = line.trim().split(/\s+/);
    if (parts[0] === "format" && parts[1] !== "binary_little_endian") {
      throw new Error("Only binary little-endian PLY files are supported");
    }
    if (parts[0] === "element") {
      inVertexElement = parts[1] === "vertex";
      if (inVertexElement) vertexCount = Number(parts[2]);
      return;
    }
    if (parts[0] !== "property" || !inVertexElement) return;
    if (parts[1] === "list" || !PLY_TYPES[parts[1]]) {
      throw new Error("Unsupported PLY vertex property");
    }

    properties.push({
      type: parts[1],
      name: parts[2],
      offset: vertexStride,
    });
    vertexStride += PLY_TYPES[parts[1]].size;
  });

  if (!vertexCount || !vertexStride) {
    throw new Error("Invalid PLY vertex declaration");
  }
  if (headerEnd + vertexCount * vertexStride > arrayBuffer.byteLength) {
    throw new Error("PLY vertex data is incomplete");
  }

  var propertyByName = {};
  properties.forEach(function (property) {
    propertyByName[property.name] = property;
  });

  var xProperty = propertyByName.x;
  var yProperty = propertyByName.y;
  var zProperty = propertyByName.z;
  var redProperty = propertyByName.red || propertyByName.r;
  var greenProperty = propertyByName.green || propertyByName.g;
  var blueProperty = propertyByName.blue || propertyByName.b;

  if (!xProperty || !yProperty || !zProperty) {
    throw new Error("PLY file does not contain x, y, and z coordinates");
  }

  var dataView = new DataView(arrayBuffer, headerEnd);
  var positions = new Float32Array(vertexCount * 3);
  var colors = new Uint8Array(vertexCount * 3);
  var minimum = [Infinity, Infinity, Infinity];
  var maximum = [-Infinity, -Infinity, -Infinity];
  var validCount = 0;

  for (var vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    var sourceOffset = vertexIndex * vertexStride;
    var x = readProperty(dataView, sourceOffset, xProperty);
    var y = -readProperty(dataView, sourceOffset, yProperty);
    var z = -readProperty(dataView, sourceOffset, zProperty);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }

    var outputOffset = validCount * 3;
    positions[outputOffset] = x;
    positions[outputOffset + 1] = y;
    positions[outputOffset + 2] = z;
    colors[outputOffset] = redProperty
      ? clamp(readProperty(dataView, sourceOffset, redProperty), 0, 255)
      : 218;
    colors[outputOffset + 1] = greenProperty
      ? clamp(readProperty(dataView, sourceOffset, greenProperty), 0, 255)
      : 226;
    colors[outputOffset + 2] = blueProperty
      ? clamp(readProperty(dataView, sourceOffset, blueProperty), 0, 255)
      : 244;

    minimum[0] = Math.min(minimum[0], x);
    minimum[1] = Math.min(minimum[1], y);
    minimum[2] = Math.min(minimum[2], z);
    maximum[0] = Math.max(maximum[0], x);
    maximum[1] = Math.max(maximum[1], y);
    maximum[2] = Math.max(maximum[2], z);
    validCount += 1;
  }

  if (!validCount) {
    throw new Error("PLY file contains no finite points");
  }

  var robustBounds = robustPointBounds(positions, validCount, minimum, maximum);
  var displayMinimum = robustBounds.minimum;
  var displayMaximum = robustBounds.maximum;
  var center = [
    (displayMinimum[0] + displayMaximum[0]) / 2,
    (displayMinimum[1] + displayMaximum[1]) / 2,
    (displayMinimum[2] + displayMaximum[2]) / 2,
  ];
  var maximumSpan = Math.max(
    displayMaximum[0] - displayMinimum[0],
    displayMaximum[1] - displayMinimum[1],
    displayMaximum[2] - displayMinimum[2],
  );
  var scale = maximumSpan > 0 ? 2 / maximumSpan : 1;

  for (var positionIndex = 0; positionIndex < validCount * 3; positionIndex += 3) {
    positions[positionIndex] = (positions[positionIndex] - center[0]) * scale;
    positions[positionIndex + 1] =
      (positions[positionIndex + 1] - center[1]) * scale;
    positions[positionIndex + 2] =
      (positions[positionIndex + 2] - center[2]) * scale;
  }

  return {
    positions:
      validCount === vertexCount ? positions : positions.slice(0, validCount * 3),
    colors: validCount === vertexCount ? colors : colors.slice(0, validCount * 3),
    count: validCount,
  };
}

self.addEventListener("message", function (event) {
  try {
    var pointCloud = parseBinaryPly(event.data.buffer);
    self.postMessage(
      {
        positions: pointCloud.positions.buffer,
        colors: pointCloud.colors.buffer,
        count: pointCloud.count,
      },
      [pointCloud.positions.buffer, pointCloud.colors.buffer],
    );
  } catch (error) {
    self.postMessage({
      error: error && error.message ? error.message : "Could not parse PLY file",
    });
  }
});
