#!/usr/bin/env python3
"""Copy PixDepth demo assets, preserving every original PLY point by default."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


PLY_TYPE_SIZES = {
    "char": 1,
    "int8": 1,
    "uchar": 1,
    "uint8": 1,
    "short": 2,
    "int16": 2,
    "ushort": 2,
    "uint16": 2,
    "int": 4,
    "int32": 4,
    "uint": 4,
    "uint32": 4,
    "float": 4,
    "float32": 4,
    "double": 8,
    "float64": 8,
}


def read_ply_header(path: Path) -> tuple[bytes, int, int, int]:
    header_lines: list[bytes] = []
    vertex_count = -1
    vertex_stride = 0
    in_vertex_element = False
    non_vertex_elements: list[tuple[str, int]] = []

    with path.open("rb") as stream:
        while True:
            line = stream.readline()
            if not line:
                raise ValueError(f"{path}: missing end_header")
            header_lines.append(line)
            text = line.decode("ascii").strip()

            if text.startswith("format ") and text != "format binary_little_endian 1.0":
                raise ValueError(f"{path}: expected binary_little_endian PLY")
            if text.startswith("element "):
                _, name, count_text = text.split()
                count = int(count_text)
                in_vertex_element = name == "vertex"
                if in_vertex_element:
                    vertex_count = count
                else:
                    non_vertex_elements.append((name, count))
            elif text.startswith("property ") and in_vertex_element:
                parts = text.split()
                if len(parts) != 3 or parts[1] == "list":
                    raise ValueError(f"{path}: unsupported vertex property {text!r}")
                try:
                    vertex_stride += PLY_TYPE_SIZES[parts[1]]
                except KeyError as error:
                    raise ValueError(
                        f"{path}: unsupported PLY property type {parts[1]!r}"
                    ) from error

            if text == "end_header":
                data_offset = stream.tell()
                break

    if vertex_count < 0 or vertex_stride <= 0:
        raise ValueError(f"{path}: invalid vertex declaration")
    if any(count for _, count in non_vertex_elements):
        raise ValueError(f"{path}: non-vertex elements are not supported")

    return b"".join(header_lines), data_offset, vertex_count, vertex_stride


def copy_ply(source: Path, destination: Path) -> dict[str, object]:
    _, _, vertex_count, _ = read_ply_header(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return {
        "vertices": vertex_count,
        "bytes": destination.stat().st_size,
        "preserved": True,
    }


def prepare_assets(
    source_root: Path,
    output_root: Path,
) -> None:
    scene_directories = sorted(
        (
            directory
            for directory in source_root.iterdir()
            if directory.is_dir()
            and (directory / "image.jpg").is_file()
            and (directory / "ply").is_dir()
        ),
        key=lambda path: path.name.casefold(),
    )
    if not scene_directories:
        raise ValueError(f"no demo scenes found in {source_root}")

    manifest: dict[str, object] = {
        "preserves_original_ply": True,
        "scenes": [],
    }

    for scene_index, scene_source in enumerate(scene_directories, start=1):
        scene_output = output_root / scene_source.name
        scene_output.mkdir(parents=True, exist_ok=True)
        shutil.copy2(scene_source / "image.jpg", scene_output / "image.jpg")

        ply_sources = sorted((scene_source / "ply").glob("*.ply"))
        if not ply_sources:
            raise ValueError(f"{scene_source}: no PLY files found")

        scene_manifest: dict[str, object] = {
            "id": scene_source.name,
            "image": f"{scene_source.name}/image.jpg",
            "methods": {},
        }

        for ply_source in ply_sources:
            ply_output = scene_output / "ply" / ply_source.name
            stats = copy_ply(ply_source, ply_output)
            scene_manifest["methods"][ply_source.stem] = stats

        manifest["scenes"].append(scene_manifest)
        print(
            f"[{scene_index:02d}/{len(scene_directories):02d}] "
            f"{scene_source.name}: {len(ply_sources)} methods"
        )

    manifest_path = output_root / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    total_bytes = sum(
        path.stat().st_size for path in output_root.rglob("*") if path.is_file()
    )
    print(f"Prepared {len(scene_directories)} scenes in {output_root}")
    print(f"Total output: {total_bytes / (1024 * 1024):.1f} MiB")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Demo source directory")
    parser.add_argument("--output", type=Path, required=True, help="Output asset directory")
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    prepare_assets(
        arguments.source.resolve(),
        arguments.output.resolve(),
    )
