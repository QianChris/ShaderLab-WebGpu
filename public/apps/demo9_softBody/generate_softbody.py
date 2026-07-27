#!/usr/bin/env python3
"""Generate a pre-baked soft-body asset file for demo9's PBD plugin.

The asset contains all structural data that used to be generated at runtime:
  - particle rest positions (axis-aligned, centered at origin, no rotation)
  - surface triangle indices (cube shell)
  - shape-matching cluster data (sparse centers, Chebyshev membership)

Cluster center selection: greedy, minimum Chebyshev spacing `clusterSpacing`
between centers. Each center's cluster = all particles within Chebyshev
radius `clusterRadius`. With clusterSpacing=clusterRadius, every particle is
covered by at least one cluster (full coverage, minimal overlap). With
clusterSpacing=0, every particle is a center (densest, maximum overlap).

The runtime PbdManager loads this file, applies a random rotation + the
entity's Transform translation, and writes the result to GPU buffers.
Changing gridN / cellSize / clusterRadius / clusterSpacing requires re-running
this script — they are not runtime-tweakable component fields.

Usage:
    python generate_softbody.py [--gridN 5] [--cellSize 0.4]
                                [--clusterRadius 2] [--clusterSpacing 2]
                                [--mass 1.0] [--output softbody_asset.json]
"""

import argparse
import json
import sys
from typing import List, Dict, Any, Tuple


def idx_at(i: int, j: int, k: int, n: int) -> int:
    return i + j * n + k * n * n


def build_surface_indices(n: int) -> List[int]:
    """Cube shell triangulation — 6 faces, 2 triangles per cell, consistent winding."""
    out: List[int] = []
    at = lambda i, j, k: idx_at(i, j, k, n)

    for j in range(n - 1):
        for k in range(n - 1):
            a, b, c, d = at(0, j, k), at(0, j+1, k), at(0, j+1, k+1), at(0, j, k+1)
            out.extend([a, b, c, a, c, d])
            a2, b2, c2, d2 = at(n-1, j, k), at(n-1, j+1, k), at(n-1, j+1, k+1), at(n-1, j, k+1)
            out.extend([a2, c2, b2, a2, d2, c2])

    for i in range(n - 1):
        for k in range(n - 1):
            a, b, c, d = at(i, 0, k), at(i+1, 0, k), at(i+1, 0, k+1), at(i, 0, k+1)
            out.extend([a, c, b, a, d, c])
            a2, b2, c2, d2 = at(i, n-1, k), at(i+1, n-1, k), at(i+1, n-1, k+1), at(i, n-1, k+1)
            out.extend([a2, b2, c2, a2, c2, d2])

    for i in range(n - 1):
        for j in range(n - 1):
            a, b, c, d = at(i, j, 0), at(i+1, j, 0), at(i+1, j+1, 0), at(i, j+1, 0)
            out.extend([a, b, c, a, c, d])
            a2, b2, c2, d2 = at(i, j, n-1), at(i+1, j, n-1), at(i+1, j+1, n-1), at(i, j+1, n-1)
            out.extend([a2, c2, b2, a2, d2, c2])

    return out


def select_centers(grid_n: int, spacing: int) -> List[Tuple[int, int, int]]:
    """Greedy selection of cluster centers: iterate in grid order, skip any
    particle within Chebyshev distance `spacing` of an already-selected center.
    Deterministic (same input → same output)."""
    centers: List[Tuple[int, int, int]] = []
    for k in range(grid_n):
        for j in range(grid_n):
            for i in range(grid_n):
                too_close = False
                for (ci, cj, ck) in centers:
                    if (abs(i - ci) <= spacing and
                        abs(j - cj) <= spacing and
                        abs(k - ck) <= spacing):
                        too_close = True
                        break
                if not too_close:
                    centers.append((i, j, k))
    return centers


def generate(grid_n: int, cell_size: float, cluster_radius: int,
             cluster_spacing: int, mass: float) -> Dict[str, Any]:
    particle_count = grid_n ** 3
    inv_mass = particle_count / mass
    half = (grid_n - 1) / 2.0

    # ── particle rest positions (axis-aligned, centered at origin) ───────
    positions: List[List[float]] = []
    for k in range(grid_n):
        for j in range(grid_n):
            for i in range(grid_n):
                x = (i - half) * cell_size
                y = (j - half) * cell_size
                z = (k - half) * cell_size
                positions.append([x, y, z, inv_mass])

    # ── surface indices ─────────────────────────────────────────────────
    surface_indices = build_surface_indices(grid_n)

    # ── select cluster centers (greedy, min Chebyshev spacing) ───────────
    centers = select_centers(grid_n, cluster_spacing)
    cluster_count = len(centers)

    # First pass: count members per cluster
    cluster_sizes = [0] * cluster_count
    for c, (ci, cj, ck) in enumerate(centers):
        cnt = 0
        for di in range(-cluster_radius, cluster_radius + 1):
            ni = ci + di
            if ni < 0 or ni >= grid_n:
                continue
            for dj in range(-cluster_radius, cluster_radius + 1):
                nj = cj + dj
                if nj < 0 or nj >= grid_n:
                    continue
                for dk in range(-cluster_radius, cluster_radius + 1):
                    nk = ck + dk
                    if nk < 0 or nk >= grid_n:
                        continue
                    cnt += 1
        cluster_sizes[c] = cnt

    # Prefix-sum for offsets
    offsets = [0] * cluster_count
    total = 0
    for c in range(cluster_count):
        offsets[c] = total
        total += cluster_sizes[c]

    cluster_entries = total

    # Second pass: write cluster data + indices + rest offsets
    clusters: List[Dict[str, Any]] = []
    cluster_indices: List[int] = [0] * cluster_entries
    rest_offsets: List[List[float]] = [[0.0, 0.0, 0.0] for _ in range(cluster_entries)]

    for c, (ci, cj, ck) in enumerate(centers):
        cnt = cluster_sizes[c]
        offset = offsets[c]

        # Rest center of mass
        com_x = com_y = com_z = 0.0
        for di in range(-cluster_radius, cluster_radius + 1):
            ni = ci + di
            if ni < 0 or ni >= grid_n:
                continue
            for dj in range(-cluster_radius, cluster_radius + 1):
                nj = cj + dj
                if nj < 0 or nj >= grid_n:
                    continue
                for dk in range(-cluster_radius, cluster_radius + 1):
                    nk = ck + dk
                    if nk < 0 or nk >= grid_n:
                        continue
                    pid = idx_at(ni, nj, nk, grid_n)
                    com_x += positions[pid][0]
                    com_y += positions[pid][1]
                    com_z += positions[pid][2]
        com_x /= cnt
        com_y /= cnt
        com_z /= cnt

        clusters.append({
            "restCom": [com_x, com_y, com_z],
            "count": cnt,
            "offset": offset,
        })

        local_idx = 0
        for di in range(-cluster_radius, cluster_radius + 1):
            ni = ci + di
            if ni < 0 or ni >= grid_n:
                continue
            for dj in range(-cluster_radius, cluster_radius + 1):
                nj = cj + dj
                if nj < 0 or nj >= grid_n:
                    continue
                for dk in range(-cluster_radius, cluster_radius + 1):
                    nk = ck + dk
                    if nk < 0 or nk >= grid_n:
                        continue
                    pid = idx_at(ni, nj, nk, grid_n)
                    slot = offset + local_idx
                    cluster_indices[slot] = pid
                    rest_offsets[slot] = [
                        positions[pid][0] - com_x,
                        positions[pid][1] - com_y,
                        positions[pid][2] - com_z,
                    ]
                    local_idx += 1

    return {
        "meta": {
            "gridN": grid_n,
            "cellSize": cell_size,
            "mass": mass,
            "clusterRadius": cluster_radius * cell_size,       # meters (actual, post-quantization)
            "clusterSpacing": cluster_spacing * cell_size,     # meters (actual)
            "clusterRadiusCells": cluster_radius,               # grid cells
            "clusterSpacingCells": cluster_spacing,             # grid cells
            "particleCount": particle_count,
            "clusterCount": cluster_count,
            "clusterEntries": cluster_entries,
            "surfaceVertexCount": len(surface_indices),
        },
        "positions": positions,
        "surfaceIndices": surface_indices,
        "clusters": clusters,
        "clusterIndices": cluster_indices,
        "restOffsets": rest_offsets,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Generate a pre-baked soft-body asset file for demo9 PBD.",
    )
    parser.add_argument("--gridN", type=int, default=5, help="grid resolution (gridN^3 particles)")
    parser.add_argument("--cellSize", type=float, default=0.4, help="particle spacing / cell edge length (m)")
    parser.add_argument("--clusterRadius", type=float, default=0.8, help="Chebyshev membership radius (meters)")
    parser.add_argument("--clusterSpacing", type=float, default=None,
                        help="min Chebyshev distance between cluster centers (meters, default: = clusterRadius)")
    parser.add_argument("--mass", type=float, default=1.0, help="total mass (kg)")
    parser.add_argument("--output", type=str, default="softbody_asset.json", help="output file path")
    args = parser.parse_args()

    if args.gridN < 2:
        print(f"error: --gridN must be >= 2, got {args.gridN}", file=sys.stderr)
        sys.exit(1)
    if args.cellSize <= 0:
        print(f"error: --cellSize must be > 0, got {args.cellSize}", file=sys.stderr)
        sys.exit(1)
    if args.clusterRadius <= 0:
        print(f"error: --clusterRadius must be > 0, got {args.clusterRadius}", file=sys.stderr)
        sys.exit(1)

    cluster_spacing_m = args.clusterSpacing if args.clusterSpacing is not None else args.clusterRadius

    # Convert meter values to grid cells (quantized — actual physical size may differ).
    cluster_radius = max(1, round(args.clusterRadius / args.cellSize))
    cluster_spacing = max(0, round(cluster_spacing_m / args.cellSize))

    if cluster_radius > args.gridN - 1:
        print(f"error: --clusterRadius {args.clusterRadius}m = {cluster_radius} cells, "
              f"must be < gridN ({args.gridN}) = {(args.gridN-1)*args.cellSize}m", file=sys.stderr)
        sys.exit(1)

    # Warn if quantization changed the actual value.
    if cluster_radius * args.cellSize != args.clusterRadius:
        print(f"warning: --clusterRadius {args.clusterRadius}m quantized to {cluster_radius} cells "
              f"= {cluster_radius * args.cellSize:.3f}m", file=sys.stderr)
    if cluster_spacing * args.cellSize != cluster_spacing_m:
        print(f"warning: --clusterSpacing {cluster_spacing_m}m quantized to {cluster_spacing} cells "
              f"= {cluster_spacing * args.cellSize:.3f}m", file=sys.stderr)

    data = generate(args.gridN, args.cellSize, cluster_radius, cluster_spacing, args.mass)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    m = data["meta"]
    cube_edge = (m["gridN"] - 1) * m["cellSize"]
    max_cluster = (2 * m["clusterRadiusCells"] + 1) ** 3
    print(
        f"Generated {args.output}:\n"
        f"  gridN={m['gridN']}  cellSize={m['cellSize']}m  cubeEdge={cube_edge:.3f}m  cubeVolume={cube_edge**3:.3f}m³\n"
        f"  clusterRadius={m['clusterRadius']}m ({m['clusterRadiusCells']} cells)"
        f"  clusterSpacing={m['clusterSpacing']}m ({m['clusterSpacingCells']} cells)  mass={m['mass']}\n"
        f"  particles={m['particleCount']}  clusters={m['clusterCount']}  clusterEntries={m['clusterEntries']}\n"
        f"  maxClusterMembers={max_cluster}  surfaceTriangles={m['surfaceVertexCount'] // 3}\n"
        f"  perParticleMass={m['mass'] / m['particleCount']:.6f} kg  invMass={m['particleCount'] / m['mass']:.1f}"
    )


if __name__ == "__main__":
    main()
