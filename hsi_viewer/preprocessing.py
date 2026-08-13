"""User-selectable preprocessing and spectral computation functions.

Every function here operates on the live in-memory working data (band-first
(B, H, W) arrays) and NEVER modifies the on-disk store. Future preprocessing
ops (baseline correction, derivatives, normalization, ...) register in
PIPELINE_OPS and are applied, in user-chosen order, to produce the working
cube; spectral computations such as integration always consume the result.
"""

from __future__ import annotations

from typing import Callable

import numpy as np
from scipy import ndimage
from scipy.signal import savgol_filter

# name -> op(cube, wavenumbers, **params) -> cube. Applied in user-chosen
# order to the raw preview to produce the working cube. Empty for now.
PIPELINE_OPS: dict[str, Callable] = {}


def clean_mask_blobs(mask: np.ndarray, min_blob_size: int = 500, expansion: int = 0,
                     pixel_proportion: float = 0.95) -> np.ndarray:
    """Keep only the largest connected blobs of a binary mask, dropping small
    speckle fragments.

    Adapted from ``pyir_image.PyIR_Image.core_mask_cleaner`` in the
    pyir_toolkit package (Dougal Ferguson, University of Manchester).
    Blobs are optionally dilated so nearby fragments merge before labelling,
    then accumulated from largest to smallest until `pixel_proportion` of the
    mask's pixels are covered; blobs below `min_blob_size` are dropped. The
    result is intersected with the original mask to undo the dilation.
    """
    original = mask.astype(bool)
    work = ndimage.binary_dilation(original, iterations=expansion) if expansion > 0 else original
    labels, n = ndimage.label(work)
    if n == 0:
        return np.zeros_like(original, dtype=np.float32)
    sizes = ndimage.sum(work, labels, index=np.arange(1, n + 1))
    order = np.argsort(sizes)[::-1]
    target = pixel_proportion * float(work.sum())
    keep = np.zeros(n + 1, dtype=bool)
    covered = 0.0
    for idx in order:
        if sizes[idx] < min_blob_size:
            break  # sizes are sorted descending; the rest are smaller
        keep[idx + 1] = True
        covered += sizes[idx]
        if covered >= target:
            break
    return (keep[labels] & original).astype(np.float32)


def sg_block(block: np.ndarray, window_length: int, poly_order: int,
             deriv: int) -> np.ndarray:
    """Savitzky-Golay smoothing / derivative along the spectral (first) axis.
    Convention follows ``pyir_spectralcollection.data_deriv`` (pyir_toolkit,
    D. Ferguson, University of Manchester); the caller trims the half-window
    edge bands and the wavenumber axis to match."""
    return savgol_filter(block, window_length=window_length,
                         polyorder=poly_order, deriv=deriv, axis=0)


def range_selection(wavenumbers: np.ndarray, lower: float, upper: float,
                    keep: bool) -> np.ndarray:
    """Band-selection mask for keep_range / remove_range (cf. the same-named
    functions in pyir_spectralcollection)."""
    if upper < lower:
        lower, upper = upper, lower
    inside = (wavenumbers >= lower) & (wavenumbers <= upper)
    return inside if keep else ~inside


def integrate_bands(cube: np.ndarray, wavenumbers: np.ndarray,
                    i0: int, i1: int) -> np.ndarray:
    """Raw trapezoidal area under the spectrum between band indices
    [i0, i1] (inclusive), per pixel. No baseline handling — the curve is
    integrated exactly as it exists in the working data."""
    i0, i1 = sorted((int(i0), int(i1)))
    if i0 == i1:
        return np.asarray(cube[i0], dtype=np.float32)
    seg = np.asarray(cube[i0 : i1 + 1], dtype=np.float32)
    x = np.asarray(wavenumbers[i0 : i1 + 1], dtype=np.float64)
    return np.trapz(seg, x=x, axis=0).astype(np.float32)


def isolate_components(mask: np.ndarray, max_count: int = 0,
                       min_area: int = 0, close_gaps: int = 2,
                       fill_holes: bool = True) -> list[dict]:
    """Find the biggest connected components of a binary mask and describe
    each one as a bounding box, ordered like reading a page (top-to-bottom
    rows, left-to-right within a row).

    Written for TMA-style data where each component is one tissue core.
    Independent of pyir's core finder, but shares the practical recipe:
    close small gaps so speckled cores don't fragment, drop dust, keep the
    N largest, then order them by grid position.

    Args:
        mask: binary image (non-zero = foreground).
        max_count: keep at most this many components (0 = all that survive).
        min_area: drop components smaller than this many pixels (0 = auto,
            2% of the LARGEST component — speckle is orders of magnitude
            smaller than a core, and a median-based rule collapses when
            specks outnumber the real regions).
        close_gaps: binary-closing radius in pixels (0 = off).
        fill_holes: fill interior holes so a ring-shaped core counts as one.

    Returns a list of {index, x0, y0, x1, y1, area, cx, cy, row} dicts in
    native pixel coords; x1/y1 are EXCLUSIVE.
    """
    work = np.asarray(mask) > 0
    if close_gaps > 0:
        work = ndimage.binary_closing(work, structure=np.ones((3, 3)),
                                      iterations=int(close_gaps))
    if fill_holes:
        work = ndimage.binary_fill_holes(work)
    labels, n = ndimage.label(work)
    if n == 0:
        return []
    areas = ndimage.sum(work, labels, index=np.arange(1, n + 1))
    if min_area <= 0:
        min_area = max(16.0, 0.02 * float(areas.max()))
    keep = [i for i in range(n) if areas[i] >= min_area]
    keep.sort(key=lambda i: areas[i], reverse=True)
    if max_count > 0:
        keep = keep[:max_count]
    if not keep:
        return []
    slices = ndimage.find_objects(labels)
    comps = []
    for i in keep:
        sy, sx = slices[i]
        comps.append({
            "x0": int(sx.start), "y0": int(sy.start),
            "x1": int(sx.stop), "y1": int(sy.stop),
            "area": int(areas[i]),
            "cx": (sx.start + sx.stop) / 2.0,
            "cy": (sy.start + sy.stop) / 2.0,
        })
    # reading order: group centres into rows, then sort left-to-right. The
    # row tolerance follows the typical component height, so a slightly
    # tilted TMA grid still numbers row by row.
    heights = [c["y1"] - c["y0"] for c in comps]
    tol = max(1.0, 0.6 * float(np.median(heights)))
    for c in sorted(comps, key=lambda c: c["cy"]):
        c["row"] = 0
    rows: list[list[dict]] = []
    for c in sorted(comps, key=lambda c: c["cy"]):
        if rows and abs(c["cy"] - rows[-1][0]["cy"]) <= tol:
            rows[-1].append(c)
        else:
            rows.append([c])
    ordered: list[dict] = []
    for r, row in enumerate(rows):
        for c in sorted(row, key=lambda c: c["cx"]):
            c["row"] = r
            c["index"] = len(ordered) + 1
            ordered.append(c)
    return ordered
