(function () {
  "use strict";

  var ASSET_ROOT = "static/media/demo";
  var DEFAULT_BASELINE = "MoGe2";
  var DEFAULT_SCENE_ID = "stair_01";
  var DEFAULT_CAMERA = {
    yaw: -0.52,
    pitch: -0.26,
    distance: 2.45,
    target: [0, 0, 0],
  };
  var MIN_CAMERA_DISTANCE = 0.0001;
  var MAX_CAMERA_DISTANCE = 7;

  var SCENES = [
    { id: "Library_01", label: "Library" },
    { id: "chair_01", label: "Chair" },
    { id: "courtyard_01", label: "Courtyard I" },
    { id: "courtyard_02", label: "Courtyard II" },
    { id: "pipe_01", label: "Pipe" },
    { id: "room_01", label: "Room I" },
    { id: "room_02", label: "Room II" },
    { id: "room_03", label: "Room III" },
    { id: "stair_01", label: "Staircase" },
    { id: "street_01", label: "Street I" },
    { id: "street_02", label: "Street II" },
    { id: "street_03", label: "Street III" },
    { id: "umic_building", label: "UMIC Building" },
    { id: "volterra", label: "Volterra" },
  ];

  var METHODS = [
    { id: "MoGe2", label: "MoGe-2" },
    { id: "DA-V2", label: "Depth Anything V2" },
    { id: "InfiniDepth", label: "InfiniDepth" },
    { id: "PPD", label: "Pixel-Perfect Depth" },
    { id: "MDA", label: "MDA" },
  ];

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function copyCamera(camera) {
    return {
      yaw: camera.yaw,
      pitch: camera.pitch,
      distance: camera.distance,
      target: camera.target.slice(),
    };
  }

  function scaleCameraDistance(distance, factor) {
    return clamp(
      distance * factor,
      MIN_CAMERA_DISTANCE,
      MAX_CAMERA_DISTANCE,
    );
  }

  var PCBIN_MAGIC = [80, 67, 66, 78]; // "PCBN"
  var PCBIN_VERSION_V1 = 1;
  var PCBIN_VERSION_V2 = 2;
  var PCBIN_V1_STRIDE = 16;
  var PCBIN_V2_STRIDE = 9;
  var PCBIN_V1_HEADER_BYTES = 32;
  var PCBIN_V2_HEADER_BYTES = 64;
  var GPU_POINT_STRIDE = 16;
  var PICK_SAMPLE_BUDGET = 250000;
  var gpuUploadQueue = Promise.resolve();

  function createAbortError() {
    var error = new Error("Point-cloud loading was cancelled");
    error.name = "AbortError";
    return error;
  }

  function parsePcbin(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < PCBIN_V1_HEADER_BYTES) {
      throw new Error("Invalid PCBIN file");
    }

    var bytes = new Uint8Array(arrayBuffer, 0, 4);
    for (var index = 0; index < PCBIN_MAGIC.length; index += 1) {
      if (bytes[index] !== PCBIN_MAGIC[index]) {
        throw new Error("Invalid PCBIN magic");
      }
    }

    var header = new DataView(arrayBuffer);
    var version = header.getUint32(4, true);
    var pointCount = header.getUint32(8, true);
    var stride = header.getUint32(12, true);
    var dataOffset = header.getUint32(16, true);

    var expectedBytes = dataOffset + pointCount * stride;
    if (!pointCount || expectedBytes !== arrayBuffer.byteLength) {
      throw new Error("PCBIN payload is incomplete");
    }

    if (version === PCBIN_VERSION_V1) {
      if (stride !== PCBIN_V1_STRIDE || dataOffset < PCBIN_V1_HEADER_BYTES) {
        throw new Error("Invalid PCBIN v1 header");
      }
      if (dataOffset % 4 !== 0) {
        throw new Error("PCBIN v1 payload is not 4-byte aligned");
      }
      return {
        buffer: arrayBuffer,
        pointData: new Float32Array(arrayBuffer, dataOffset, pointCount * 4),
        gpuBytes: new Uint8Array(arrayBuffer, dataOffset, pointCount * stride),
        count: pointCount,
      };
    }

    if (
      version !== PCBIN_VERSION_V2 ||
      stride !== PCBIN_V2_STRIDE ||
      dataOffset < PCBIN_V2_HEADER_BYTES
    ) {
      throw new Error("Unsupported PCBIN version or stride: " + version + "/" + stride);
    }

    var flags = header.getUint32(20, true);
    if (!(flags & 1)) {
      throw new Error("PCBIN v2 quantized-position flag is missing");
    }
    var minimum = [
      header.getFloat32(24, true),
      header.getFloat32(28, true),
      header.getFloat32(32, true),
    ];
    var maximum = [
      header.getFloat32(36, true),
      header.getFloat32(40, true),
      header.getFloat32(44, true),
    ];
    var scales = minimum.map(function (value, axis) {
      return (maximum[axis] - value) / 65535;
    });
    var payload = new Uint8Array(arrayBuffer, dataOffset, pointCount * stride);
    var gpuBuffer = new ArrayBuffer(pointCount * GPU_POINT_STRIDE);
    var gpuFloats = new Float32Array(gpuBuffer);
    var gpuBytes = new Uint8Array(gpuBuffer);

    for (var pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      var sourceOffset = pointIndex * PCBIN_V2_STRIDE;
      var floatOffset = pointIndex * 4;
      var byteOffset = pointIndex * GPU_POINT_STRIDE;
      var quantizedX = payload[sourceOffset] | (payload[sourceOffset + 1] << 8);
      var quantizedY = payload[sourceOffset + 2] | (payload[sourceOffset + 3] << 8);
      var quantizedZ = payload[sourceOffset + 4] | (payload[sourceOffset + 5] << 8);
      gpuFloats[floatOffset] = minimum[0] + quantizedX * scales[0];
      gpuFloats[floatOffset + 1] = minimum[1] + quantizedY * scales[1];
      gpuFloats[floatOffset + 2] = minimum[2] + quantizedZ * scales[2];
      gpuBytes[byteOffset + 12] = payload[sourceOffset + 6];
      gpuBytes[byteOffset + 13] = payload[sourceOffset + 7];
      gpuBytes[byteOffset + 14] = payload[sourceOffset + 8];
      gpuBytes[byteOffset + 15] = 255;
    }

    return {
      buffer: gpuBuffer,
      pointData: gpuFloats,
      gpuBytes: gpuBytes,
      count: pointCount,
    };
  }

  function waitForNextFrame() {
    return new Promise(function (resolve) {
      window.requestAnimationFrame(function () {
        resolve();
      });
    });
  }

  function enqueueGpuUpload(callback) {
    var queued = gpuUploadQueue
      .then(waitForNextFrame)
      .then(callback);

    gpuUploadQueue = queued.catch(function () {
      // Keep the queue usable after a failed or aborted upload.
    });

    return queued;
  }

  function createShader(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var message = gl.getShaderInfoLog(shader) || "Unknown shader error";
      gl.deleteShader(shader);
      throw new Error(message);
    }

    return shader;
  }

  function createProgram(gl) {
    var vertexSource = [
      "attribute vec3 aPosition;",
      "attribute vec3 aColor;",
      "uniform mat4 uProjection;",
      "uniform mat4 uView;",
      "uniform float uPointSize;",
      "varying vec3 vColor;",
      "void main() {",
      "  vec4 viewPosition = uView * vec4(aPosition, 1.0);",
      "  gl_Position = uProjection * viewPosition;",
      "  float scaledSize = uPointSize / max(0.65, -viewPosition.z);",
      "  gl_PointSize = clamp(scaledSize, 1.25, 5.5);",
      "  vColor = aColor;",
      "}",
    ].join("\n");

    var fragmentSource = [
      "precision mediump float;",
      "varying vec3 vColor;",
      "void main() {",
      "  vec2 point = gl_PointCoord - vec2(0.5);",
      "  if (dot(point, point) > 0.25) discard;",
      "  gl_FragColor = vec4(vColor, 1.0);",
      "}",
    ].join("\n");

    var vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    var fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    var program = gl.createProgram();

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      var message = gl.getProgramInfoLog(program) || "Unknown program error";
      gl.deleteProgram(program);
      throw new Error(message);
    }

    return program;
  }

  function perspectiveMatrix(fieldOfView, aspect, near, far) {
    var f = 1 / Math.tan(fieldOfView / 2);
    var rangeInverse = 1 / (near - far);

    return new Float32Array([
      f / aspect,
      0,
      0,
      0,
      0,
      f,
      0,
      0,
      0,
      0,
      (near + far) * rangeInverse,
      -1,
      0,
      0,
      near * far * rangeInverse * 2,
      0,
    ]);
  }

  function normalizeVector(vector) {
    var length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
    return [vector[0] / length, vector[1] / length, vector[2] / length];
  }

  function crossProduct(left, right) {
    return [
      left[1] * right[2] - left[2] * right[1],
      left[2] * right[0] - left[0] * right[2],
      left[0] * right[1] - left[1] * right[0],
    ];
  }

  function lookAtMatrix(eye, target, up) {
    var forward = normalizeVector([
      eye[0] - target[0],
      eye[1] - target[1],
      eye[2] - target[2],
    ]);
    var right = normalizeVector(crossProduct(up, forward));
    var cameraUp = crossProduct(forward, right);

    return new Float32Array([
      right[0],
      cameraUp[0],
      forward[0],
      0,
      right[1],
      cameraUp[1],
      forward[1],
      0,
      right[2],
      cameraUp[2],
      forward[2],
      0,
      -(right[0] * eye[0] + right[1] * eye[1] + right[2] * eye[2]),
      -(cameraUp[0] * eye[0] + cameraUp[1] * eye[1] + cameraUp[2] * eye[2]),
      -(forward[0] * eye[0] + forward[1] * eye[1] + forward[2] * eye[2]),
      1,
    ]);
  }

  async function fetchArrayBuffer(url, signal, onProgress) {
    var response = await fetch(url, {
      signal: signal,
      credentials: "same-origin",
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status + " while loading " + url);
    }

    var total = Number(response.headers.get("content-length")) || 0;
    onProgress(0, total);

    // Fast path: let the browser build the ArrayBuffer internally instead of
    // repeatedly pushing network chunks into JS arrays and merging them.
    var buffer = await response.arrayBuffer();

    onProgress(buffer.byteLength, total || buffer.byteLength);
    return buffer;
  }

  function PointCloudViewer(canvas, onCameraChange) {
    this.canvas = canvas;
    this.viewport = canvas.closest(".pointcloud-viewport");
    this.statusText = this.viewport.querySelector("[data-viewer-status]");
    this.progressText = this.viewport.querySelector("[data-viewer-progress]");
    this.progressBar = this.viewport.querySelector("[data-viewer-progress-bar]");
    this.progressFill = this.viewport.querySelector("[data-viewer-progress-fill]");
    this.onCameraChange = onCameraChange;
    this.camera = copyCamera(DEFAULT_CAMERA);
    this.pointers = new Map();
    this.positions = null;
    this.pointCount = 0;
    this.focusMarker = this.viewport.querySelector("[data-focus-marker]");
    this.focusMarkerTimer = 0;
    this.renderQueued = false;
    this.loadSequence = 0;
    this.abortController = null;

    try {
      this.gl = canvas.getContext("webgl", {
        alpha: false,
        antialias: false,
        depth: true,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false,
      });
      if (!this.gl) throw new Error("WebGL is unavailable in this browser");
      this.initializeGraphics();
      this.bindInteractions();
      this.observeSize();
      this.setState("loading", "Waiting for point cloud", "");
      this.setProgress(0, 0);
    } catch (error) {
      this.setState("error", "Interactive viewer unavailable", error.message);
    }
  }

  PointCloudViewer.prototype.initializeGraphics = function () {
    var gl = this.gl;
    this.program = createProgram(gl);
    this.pointBuffer = gl.createBuffer();
    this.locations = {
      position: gl.getAttribLocation(this.program, "aPosition"),
      color: gl.getAttribLocation(this.program, "aColor"),
      projection: gl.getUniformLocation(this.program, "uProjection"),
      view: gl.getUniformLocation(this.program, "uView"),
      pointSize: gl.getUniformLocation(this.program, "uPointSize"),
    };

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.clearColor(0.882, 0.894, 0.91, 1);

    this.canvas.addEventListener(
      "webglcontextlost",
      function (event) {
        event.preventDefault();
        this.setState(
          "error",
          "The 3D viewer paused",
          "Reload the page to restore WebGL",
        );
      }.bind(this),
    );
  };

  PointCloudViewer.prototype.observeSize = function () {
    var resize = this.resize.bind(this);
    if ("ResizeObserver" in window) {
      this.resizeObserver = new ResizeObserver(resize);
      this.resizeObserver.observe(this.canvas);
    } else {
      window.addEventListener("resize", resize);
    }
    resize();
  };

  PointCloudViewer.prototype.resize = function () {
    if (!this.gl) return;
    var pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    var width = Math.max(1, Math.round(this.canvas.clientWidth * pixelRatio));
    var height = Math.max(1, Math.round(this.canvas.clientHeight * pixelRatio));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.gl.viewport(0, 0, width, height);
      this.requestRender();
    }
  };

  PointCloudViewer.prototype.bindInteractions = function () {
    var canvas = this.canvas;
    var viewer = this;

    canvas.addEventListener("contextmenu", function (event) {
      event.preventDefault();
    });

    canvas.addEventListener("pointerdown", function (event) {
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      viewer.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        button: event.button,
        pan: event.button === 2 || event.shiftKey || event.ctrlKey,
      });
      viewer.updateGestureAnchor();
    });

    canvas.addEventListener("pointermove", function (event) {
      if (!viewer.pointers.has(event.pointerId)) return;

      var previous = viewer.pointers.get(event.pointerId);
      viewer.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        button: previous.button,
        pan: previous.pan,
      });

      if (viewer.pointers.size === 1) {
        var deltaX = event.clientX - previous.x;
        var deltaY = event.clientY - previous.y;

        if (previous.pan) {
          viewer.panCamera(deltaX, deltaY);
        } else {
          viewer.camera.yaw -= deltaX * 0.006;
          viewer.camera.pitch = clamp(
            viewer.camera.pitch + deltaY * 0.006,
            -1.35,
            1.35,
          );
        }
        viewer.cameraChanged();
      } else if (viewer.pointers.size === 2) {
        var pointerValues = Array.from(viewer.pointers.values());
        var pinchDistance = Math.hypot(
          pointerValues[0].x - pointerValues[1].x,
          pointerValues[0].y - pointerValues[1].y,
        );
        if (viewer.gestureDistance && pinchDistance) {
          viewer.camera.distance = scaleCameraDistance(
            viewer.camera.distance,
            viewer.gestureDistance / pinchDistance,
          );
          viewer.cameraChanged();
        }
        viewer.gestureDistance = pinchDistance;
      }
    });

    function endPointer(event) {
      viewer.pointers.delete(event.pointerId);
      viewer.updateGestureAnchor();
    }

    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);

    canvas.addEventListener(
      "wheel",
      function (event) {
        event.preventDefault();
        viewer.camera.distance = scaleCameraDistance(
          viewer.camera.distance,
          Math.exp(event.deltaY * 0.0011),
        );
        viewer.cameraChanged();
      },
      { passive: false },
    );

    canvas.addEventListener("dblclick", function (event) {
      event.preventDefault();
      viewer.focusAt(event.clientX, event.clientY);
    });

    canvas.addEventListener("keydown", function (event) {
      var handled = true;
      if (event.key === "ArrowLeft") viewer.camera.yaw += 0.08;
      else if (event.key === "ArrowRight") viewer.camera.yaw -= 0.08;
      else if (event.key === "ArrowUp") {
        viewer.camera.pitch = clamp(viewer.camera.pitch + 0.08, -1.35, 1.35);
      } else if (event.key === "ArrowDown") {
        viewer.camera.pitch = clamp(viewer.camera.pitch - 0.08, -1.35, 1.35);
      } else if (event.key === "+" || event.key === "=") {
        viewer.camera.distance = scaleCameraDistance(viewer.camera.distance, 0.9);
      } else if (event.key === "-" || event.key === "_") {
        viewer.camera.distance = scaleCameraDistance(viewer.camera.distance, 1.1);
      } else if (event.key.toLowerCase() === "r") {
        viewer.resetCamera(true);
        return;
      } else {
        handled = false;
      }

      if (handled) {
        event.preventDefault();
        viewer.cameraChanged();
      }
    });
  };

  PointCloudViewer.prototype.updateGestureAnchor = function () {
    if (this.pointers.size === 2) {
      var pointerValues = Array.from(this.pointers.values());
      this.gestureDistance = Math.hypot(
        pointerValues[0].x - pointerValues[1].x,
        pointerValues[0].y - pointerValues[1].y,
      );
    } else {
      this.gestureDistance = 0;
    }
  };

  PointCloudViewer.prototype.panCamera = function (deltaX, deltaY) {
    var scale = (this.camera.distance * 0.0015) / Math.max(1, this.canvas.clientHeight / 700);
    var cosine = Math.cos(this.camera.yaw);
    var sine = Math.sin(this.camera.yaw);
    this.camera.target[0] -= deltaX * scale * cosine;
    this.camera.target[2] += deltaX * scale * sine;
    this.camera.target[1] += deltaY * scale;
  };

  PointCloudViewer.prototype.cameraChanged = function () {
    this.requestRender();
    if (this.onCameraChange) this.onCameraChange(copyCamera(this.camera), this);
  };

  PointCloudViewer.prototype.setCamera = function (camera, notify) {
    this.camera = copyCamera(camera);
    this.requestRender();
    if (notify && this.onCameraChange) {
      this.onCameraChange(copyCamera(this.camera), this);
    }
  };

  PointCloudViewer.prototype.resetCamera = function (notify) {
    this.setCamera(DEFAULT_CAMERA, notify);
  };

  PointCloudViewer.prototype.getCameraFrame = function () {
    var camera = this.camera;
    var cosinePitch = Math.cos(camera.pitch);
    var eye = [
      camera.target[0] + camera.distance * Math.sin(camera.yaw) * cosinePitch,
      camera.target[1] + camera.distance * Math.sin(camera.pitch),
      camera.target[2] + camera.distance * Math.cos(camera.yaw) * cosinePitch,
    ];
    var forward = normalizeVector([
      camera.target[0] - eye[0],
      camera.target[1] - eye[1],
      camera.target[2] - eye[2],
    ]);
    var right = normalizeVector(crossProduct(forward, [0, 1, 0]));
    var up = normalizeVector(crossProduct(right, forward));

    return { eye: eye, forward: forward, right: right, up: up };
  };

  PointCloudViewer.prototype.showFocusMarker = function () {
    if (!this.focusMarker) return;
    window.clearTimeout(this.focusMarkerTimer);
    this.focusMarker.classList.remove("is-visible");
    void this.focusMarker.offsetWidth;
    this.focusMarker.classList.add("is-visible");
    this.focusMarkerTimer = window.setTimeout(
      function () {
        this.focusMarker.classList.remove("is-visible");
      }.bind(this),
      850,
    );
  };

  PointCloudViewer.prototype.focusAt = function (clientX, clientY) {
    if (!this.positions || !this.pointCount) return false;

    var rectangle = this.canvas.getBoundingClientRect();
    if (!rectangle.width || !rectangle.height) return false;

    var targetX = clientX - rectangle.left;
    var targetY = clientY - rectangle.top;
    var frame = this.getCameraFrame();
    var tangent = Math.tan((48 * Math.PI) / 360);
    var aspect = rectangle.width / rectangle.height;
    var pickRadius = clamp(
      Math.min(rectangle.width, rectangle.height) * 0.06,
      26,
      38,
    );
    var maximumDistanceSquared = pickRadius * pickRadius;
    var bestIndex = -1;
    var bestDistanceSquared = maximumDistanceSquared;
    var bestDepth = Infinity;

    var pickStride = Math.max(
      1,
      Math.floor(this.pointCount / PICK_SAMPLE_BUDGET),
    );

    for (
      var pointIndex = 0;
      pointIndex < this.pointCount;
      pointIndex += pickStride
    ) {
      var index = pointIndex * 4;
      var relativeX = this.positions[index] - frame.eye[0];
      var relativeY = this.positions[index + 1] - frame.eye[1];
      var relativeZ = this.positions[index + 2] - frame.eye[2];
      var depth =
        relativeX * frame.forward[0] +
        relativeY * frame.forward[1] +
        relativeZ * frame.forward[2];
      if (depth <= 0.01) continue;

      var normalizedX =
        (relativeX * frame.right[0] +
          relativeY * frame.right[1] +
          relativeZ * frame.right[2]) /
        (depth * tangent * aspect);
      var normalizedY =
        (relativeX * frame.up[0] +
          relativeY * frame.up[1] +
          relativeZ * frame.up[2]) /
        (depth * tangent);
      if (
        normalizedX < -1.08 ||
        normalizedX > 1.08 ||
        normalizedY < -1.08 ||
        normalizedY > 1.08
      ) {
        continue;
      }

      var pixelX = (normalizedX * 0.5 + 0.5) * rectangle.width;
      var pixelY = (0.5 - normalizedY * 0.5) * rectangle.height;
      var deltaX = pixelX - targetX;
      var deltaY = pixelY - targetY;
      var distanceSquared = deltaX * deltaX + deltaY * deltaY;

      if (
        distanceSquared < bestDistanceSquared - 0.25 ||
        (Math.abs(distanceSquared - bestDistanceSquared) <= 0.25 &&
          depth < bestDepth)
      ) {
        bestIndex = index;
        bestDistanceSquared = distanceSquared;
        bestDepth = depth;
      }
    }

    if (bestIndex < 0) return false;

    var nextTarget = [
      this.positions[bestIndex],
      this.positions[bestIndex + 1],
      this.positions[bestIndex + 2],
    ];
    var offset = [
      frame.eye[0] - nextTarget[0],
      frame.eye[1] - nextTarget[1],
      frame.eye[2] - nextTarget[2],
    ];
    var distance = Math.hypot(offset[0], offset[1], offset[2]);
    if (distance < 0.01) return false;

    this.camera.target = nextTarget;
    this.camera.distance = distance;
    this.camera.yaw = Math.atan2(offset[0], offset[2]);
    this.camera.pitch = Math.asin(clamp(offset[1] / distance, -1, 1));
    this.showFocusMarker();
    this.cameraChanged();
    return true;
  };

  PointCloudViewer.prototype.requestRender = function () {
    if (this.renderQueued || !this.gl) return;
    this.renderQueued = true;
    window.requestAnimationFrame(
      function () {
        this.renderQueued = false;
        this.render();
      }.bind(this),
    );
  };

  PointCloudViewer.prototype.render = function () {
    var gl = this.gl;
    if (!gl) return;

    this.resize();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.pointCount) return;

    var camera = this.camera;
    var eye = this.getCameraFrame().eye;
    var nearPlane = Math.max(0.000001, Math.min(0.01, camera.distance * 0.01));
    var projection = perspectiveMatrix(
      (48 * Math.PI) / 180,
      this.canvas.width / Math.max(1, this.canvas.height),
      nearPlane,
      40,
    );
    var view = lookAtMatrix(eye, camera.target, [0, 1, 0]);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.locations.projection, false, projection);
    gl.uniformMatrix4fv(this.locations.view, false, view);
    var densityScale = clamp(
      Math.sqrt(300000 / Math.max(1, this.pointCount)),
      0.62,
      1,
    );
    gl.uniform1f(
      this.locations.pointSize,
      7.4 * densityScale * Math.min(window.devicePixelRatio || 1, 2),
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);

    gl.enableVertexAttribArray(this.locations.position);
    gl.vertexAttribPointer(
      this.locations.position,
      3,
      gl.FLOAT,
      false,
      GPU_POINT_STRIDE,
      0,
    );

    gl.enableVertexAttribArray(this.locations.color);
    gl.vertexAttribPointer(
      this.locations.color,
      3,
      gl.UNSIGNED_BYTE,
      true,
      GPU_POINT_STRIDE,
      12,
    );

    gl.drawArrays(gl.POINTS, 0, this.pointCount);
  };

  PointCloudViewer.prototype.setPointCloud = function (pointCloud) {
    var gl = this.gl;
    if (!gl) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, pointCloud.gpuBytes, gl.STATIC_DRAW);

    // Keep a Float32 view of the same interleaved buffer for focus picking.
    // Each point occupies 4 float slots: x, y, z, [packed RGBA bytes].
    this.positions = pointCloud.pointData;
    this.pointCount = pointCloud.count;
    this.requestRender();
  };

  PointCloudViewer.prototype.setState = function (state, message, detail) {
    if (!this.viewport) return;
    this.viewport.setAttribute("data-state", state);
    this.statusText.textContent = message || "";
    this.progressText.textContent = detail || "";
  };

  PointCloudViewer.prototype.setProgress = function (received, total) {
    if (!this.progressBar || !this.progressFill) return;

    if (total > 0) {
      var percentage = clamp((received / total) * 100, 0, 100);
      this.progressBar.classList.remove("is-indeterminate");
      this.progressBar.setAttribute(
        "aria-valuenow",
        String(Math.round(percentage)),
      );
      this.progressBar.setAttribute(
        "aria-valuetext",
        Math.round(percentage) + "%",
      );
      this.progressFill.style.transform = "scaleX(" + percentage / 100 + ")";
    } else {
      this.progressBar.classList.add("is-indeterminate");
      this.progressBar.removeAttribute("aria-valuenow");
      this.progressBar.setAttribute("aria-valuetext", "Loading");
      this.progressFill.style.removeProperty("transform");
    }
  };

  PointCloudViewer.prototype.load = async function (url, label) {
    if (!this.gl) return;
    this.loadSequence += 1;
    var sequence = this.loadSequence;

    if (this.abortController) this.abortController.abort();
    this.abortController = new AbortController();
    this.setState("loading", "Loading " + label, "");
    this.setProgress(0, 0);

    try {
      var buffer = await fetchArrayBuffer(
        url,
        this.abortController.signal,
        function (received, total) {
          if (sequence !== this.loadSequence) return;

          if (received === 0) {
            this.setProgress(0, total);
            this.setState("loading", "Loading " + label, "");
            return;
          }

          this.setProgress(received, total || received);
          this.setState("loading", "Preparing " + label, "100%");
        }.bind(this),
      );

      if (sequence !== this.loadSequence) return;

      var pointCloud = parsePcbin(buffer);

      await enqueueGpuUpload(
        function () {
          if (sequence !== this.loadSequence || this.abortController.signal.aborted) {
            throw createAbortError();
          }
          this.setPointCloud(pointCloud);
        }.bind(this),
      );

      if (sequence !== this.loadSequence) return;

      this.setState(
        "ready",
        label,
        pointCloud.count.toLocaleString() + " points",
      );
    } catch (error) {
      if (error.name === "AbortError" || sequence !== this.loadSequence) return;
      console.error(error);
      this.setState(
        "error",
        "Could not load " + label,
        "Run the offline asset converter, then select the scene again to retry",
      );
    }
  };

  function initializeScenePicker(root, onSelect) {
    var strip = root.querySelector("[data-scene-strip]");
    var preview = root.querySelector("[data-scene-preview]");
    var previewImage = preview.querySelector("img");
    var buttons = [];

    document.body.appendChild(preview);

    function hidePreview() {
      preview.classList.remove("is-visible");
      preview.setAttribute("aria-hidden", "true");
    }

    function positionPreview(event) {
      var margin = 16;
      var previewWidth = preview.offsetWidth || 360;
      var previewHeight = preview.offsetHeight || 270;
      var left = event.clientX + 20;
      var top = event.clientY - previewHeight - 18;

      if (left + previewWidth > window.innerWidth - margin) {
        left = event.clientX - previewWidth - 20;
      }
      if (top < margin) top = event.clientY + 20;
      left = clamp(left, margin, Math.max(margin, window.innerWidth - previewWidth - margin));
      top = clamp(top, margin, Math.max(margin, window.innerHeight - previewHeight - margin));
      preview.style.transform = "translate3d(" + left + "px," + top + "px,0)";
    }

    SCENES.forEach(function (scene, index) {
      var button = document.createElement("button");
      var image = document.createElement("img");
      var imageUrl = ASSET_ROOT + "/" + scene.id + "/image.jpg";
      var imageWebpUrl = ASSET_ROOT + "/" + scene.id + "/image.webp";
      var thumbnailUrl = ASSET_ROOT + "/" + scene.id + "/image-thumb.webp";

      button.className = "scene-card";
      button.type = "button";
      button.setAttribute("role", "option");
      button.setAttribute("aria-label", "View " + scene.label + " point clouds");
      var isDefaultScene = scene.id === DEFAULT_SCENE_ID;
      button.setAttribute("aria-selected", isDefaultScene ? "true" : "false");
      if (isDefaultScene) button.classList.add("is-selected");

      image.src = thumbnailUrl;
      image.alt = "";
      image.loading = index < 5 ? "eager" : "lazy";
      image.decoding = "async";
      image.addEventListener(
        "error",
        function () {
          if (image.src.endsWith("/image.jpg")) return;
          image.src = imageUrl;
        },
        { once: true },
      );
      button.appendChild(image);
      strip.appendChild(button);
      buttons.push(button);

      button.addEventListener("click", function () {
        onSelect(scene, index);
      });
      button.addEventListener("pointerenter", function (event) {
        if (event.pointerType && event.pointerType !== "mouse") return;
        previewImage.onerror = function () {
          previewImage.onerror = null;
          previewImage.src = imageUrl;
        };
        previewImage.src = imageWebpUrl;
        previewImage.alt = scene.label + " input image preview";
        preview.classList.add("is-visible");
        preview.setAttribute("aria-hidden", "false");
        positionPreview(event);
      });
      button.addEventListener("pointermove", function (event) {
        if (preview.classList.contains("is-visible")) positionPreview(event);
      });
      button.addEventListener("pointerleave", hidePreview);
    });

    strip.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      var currentIndex = buttons.indexOf(document.activeElement);
      if (currentIndex < 0) return;
      event.preventDefault();
      var direction = event.key === "ArrowRight" ? 1 : -1;
      var nextIndex = (currentIndex + direction + buttons.length) % buttons.length;
      buttons[nextIndex].focus();
      buttons[nextIndex].click();
    });

    window.addEventListener("scroll", hidePreview, { passive: true });
    window.addEventListener("blur", hidePreview);

    return function selectButton(index) {
      buttons.forEach(function (button, buttonIndex) {
        var selected = buttonIndex === index;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-selected", selected ? "true" : "false");
      });
      if (buttons[index]) {
        var selectedButton = buttons[index];
        var targetLeft =
          selectedButton.offsetLeft -
          (strip.clientWidth - selectedButton.offsetWidth) / 2;
        strip.scrollLeft = Math.max(0, targetLeft);
      }
      hidePreview();
    };
  }

  function initializeDemo() {
    var root = document.querySelector("[data-pointcloud-demo]");
    if (!root || root.getAttribute("data-initialized") === "true") return;
    root.setAttribute("data-initialized", "true");

    var leftCanvas = root.querySelector("[data-viewer='ours']");
    var rightCanvas = root.querySelector("[data-viewer='baseline']");
    var methodPicker = root.querySelector("[data-method-picker]");
    var methodTrigger = root.querySelector("[data-method-trigger]");
    var methodMenu = root.querySelector("[data-method-menu]");
    var selectedMethodLabel = root.querySelector("[data-method-label]");
    var resetButton = root.querySelector("[data-reset-view]");
    var adjustButtons = Array.from(root.querySelectorAll("[data-adjust-view]"));
    var sceneName = root.querySelector("[data-scene-name]");
    var sceneCounter = root.querySelector("[data-scene-counter]");
    var currentSceneIndex = SCENES.findIndex(function (scene) {
      return scene.id === DEFAULT_SCENE_ID;
    });
    if (currentSceneIndex < 0) currentSceneIndex = 0;
    var selectedMethodId = DEFAULT_BASELINE;
    var adjustingViewer = null;
    var cameraSnapshots = new Map();

    METHODS.forEach(function (method) {
      var option = document.createElement("button");
      option.className = "pointcloud-method-option";
      option.type = "button";
      option.setAttribute("role", "option");
      option.setAttribute("data-method-id", method.id);
      option.setAttribute(
        "aria-selected",
        method.id === selectedMethodId ? "true" : "false",
      );
      option.innerHTML =
        '<span class="pointcloud-method-check" aria-hidden="true">' +
        '<svg viewBox="0 0 16 16"><path d="m3.5 8.2 2.8 2.9 6.2-6.2" /></svg>' +
        "</span><span>" +
        method.label +
        "</span>";
      methodMenu.appendChild(option);
    });

    var methodOptions = Array.from(
      methodMenu.querySelectorAll("[data-method-id]"),
    );

    function closeMethodMenu(restoreFocus) {
      methodMenu.hidden = true;
      methodTrigger.setAttribute("aria-expanded", "false");
      if (restoreFocus) methodTrigger.focus();
    }

    function openMethodMenu() {
      methodMenu.hidden = false;
      methodTrigger.setAttribute("aria-expanded", "true");
    }

    function selectMethod(methodId) {
      selectedMethodId = methodId;
      selectedMethodLabel.textContent = methodLabel(methodId);
      methodOptions.forEach(function (option) {
        option.setAttribute(
          "aria-selected",
          option.getAttribute("data-method-id") === methodId ? "true" : "false",
        );
      });
      closeMethodMenu(true);
      loadBaseline();
    }

    methodOptions.forEach(function (option) {
      option.addEventListener("click", function () {
        selectMethod(option.getAttribute("data-method-id"));
      });
    });

    methodTrigger.addEventListener("click", function () {
      if (methodMenu.hidden) openMethodMenu();
      else closeMethodMenu(false);
    });

    methodTrigger.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      openMethodMenu();
      var selectedIndex = methodOptions.findIndex(function (option) {
        return option.getAttribute("aria-selected") === "true";
      });
      var focusIndex = event.key === "ArrowUp"
        ? Math.max(0, selectedIndex - 1)
        : Math.min(methodOptions.length - 1, selectedIndex + 1);
      methodOptions[focusIndex].focus();
    });

    methodMenu.addEventListener("keydown", function (event) {
      var currentIndex = methodOptions.indexOf(document.activeElement);
      var nextIndex = currentIndex;
      if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % methodOptions.length;
      else if (event.key === "ArrowUp") {
        nextIndex = (currentIndex - 1 + methodOptions.length) % methodOptions.length;
      } else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = methodOptions.length - 1;
      else if (event.key === "Escape") {
        event.preventDefault();
        closeMethodMenu(true);
        return;
      } else return;
      event.preventDefault();
      methodOptions[nextIndex].focus();
    });

    document.addEventListener("click", function (event) {
      if (!methodMenu.hidden && !methodPicker.contains(event.target)) {
        closeMethodMenu(false);
      }
    });

    var leftViewer;
    var rightViewer;

    function captureCameraSnapshots() {
      cameraSnapshots.set(leftViewer, copyCamera(leftViewer.camera));
      cameraSnapshots.set(rightViewer, copyCamera(rightViewer.camera));
    }

    function synchronizeCamera(camera, source) {
      if (adjustingViewer) return;

      var target = source === leftViewer ? rightViewer : leftViewer;
      var previous = cameraSnapshots.get(source);
      if (!previous) {
        captureCameraSnapshots();
        return;
      }

      var nextCamera = copyCamera(target.camera);
      var distanceFactor = previous.distance
        ? camera.distance / previous.distance
        : 1;
      nextCamera.yaw += camera.yaw - previous.yaw;
      nextCamera.pitch = clamp(
        nextCamera.pitch + camera.pitch - previous.pitch,
        -1.35,
        1.35,
      );
      nextCamera.distance = scaleCameraDistance(
        nextCamera.distance,
        distanceFactor,
      );
      nextCamera.target[0] += camera.target[0] - previous.target[0];
      nextCamera.target[1] += camera.target[1] - previous.target[1];
      nextCamera.target[2] += camera.target[2] - previous.target[2];
      target.setCamera(nextCamera, false);
      cameraSnapshots.set(source, copyCamera(camera));
      cameraSnapshots.set(target, copyCamera(nextCamera));
    }

    leftViewer = new PointCloudViewer(leftCanvas, synchronizeCamera);
    rightViewer = new PointCloudViewer(rightCanvas, synchronizeCamera);

    var viewerById = {
      ours: leftViewer,
      baseline: rightViewer,
    };

    function setAdjustmentState(viewer) {
      adjustingViewer = viewer;

      adjustButtons.forEach(function (button) {
        var buttonViewer = viewerById[button.getAttribute("data-adjust-view")];
        var isActive = buttonViewer === viewer;
        button.disabled = Boolean(viewer && !isActive);
        button.setAttribute("aria-pressed", isActive ? "true" : "false");
        button.textContent = isActive ? "Done" : "Adjust";
        button.setAttribute(
          "aria-label",
          isActive
            ? "Finish adjusting this view and relink both views"
            : "Adjust this view independently",
        );

        var panel = button.closest(".pointcloud-panel");
        panel.classList.toggle("is-adjusting", isActive);
        panel.classList.toggle(
          "is-adjustment-paused",
          Boolean(viewer && !isActive),
        );
        var canvas = panel.querySelector(".pointcloud-canvas");
        if (viewer && !isActive) canvas.setAttribute("aria-disabled", "true");
        else canvas.removeAttribute("aria-disabled");
      });

      if (!viewer) captureCameraSnapshots();
    }

    adjustButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        var viewer = viewerById[button.getAttribute("data-adjust-view")];
        setAdjustmentState(adjustingViewer === viewer ? null : viewer);
      });
    });

    function methodLabel(methodId) {
      var method = METHODS.find(function (candidate) {
        return candidate.id === methodId;
      });
      return method ? method.label : methodId;
    }

    function pointCloudUrl(scene, methodId) {
      return ASSET_ROOT + "/" + scene.id + "/pcbin/" + methodId + ".pcbin";
    }

    function resetViews() {
      leftViewer.resetCamera(false);
      rightViewer.resetCamera(false);
      setAdjustmentState(null);
    }

    function loadBaseline() {
      var scene = SCENES[currentSceneIndex];
      var baselineId = selectedMethodId;
      rightViewer.load(pointCloudUrl(scene, baselineId), methodLabel(baselineId));
    }

    function selectScene(scene, index) {
      currentSceneIndex = index;
      sceneName.textContent = scene.label;
      sceneCounter.textContent = String(index + 1).padStart(2, "0") + " / " + SCENES.length;
      updateSelectedScene(index);
      resetViews();
      leftViewer.load(pointCloudUrl(scene, "Ours"), "PXDepth (Ours)");
      loadBaseline();
    }

    var updateSelectedScene = initializeScenePicker(root, selectScene);

    resetButton.addEventListener("click", resetViews);

    selectScene(SCENES[currentSceneIndex], currentSceneIndex);
  }

  function initializeDemoWhenVisible() {
    var root = document.querySelector("[data-pointcloud-demo]");
    if (!root) return;

    if (!("IntersectionObserver" in window)) {
      initializeDemo();
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        if (!entries.some(function (entry) { return entry.isIntersecting; })) {
          return;
        }
        observer.disconnect();
        initializeDemo();
      },
      {
        rootMargin: "120px 0px",
        threshold: 0.01,
      },
    );

    observer.observe(root);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeDemoWhenVisible, {
      once: true,
    });
  } else {
    initializeDemoWhenVisible();
  }
})();
