"""IDX price ticks (fraksi harga), per IDX Regulation II-A.

An order can only be placed on a valid tick, so any price suggested by the AI
or analysis must be rounded onto one.
"""

from __future__ import annotations

import math
from typing import Literal

# Lower bound of each band, descending, paired with its tick size
BANDS: tuple[tuple[int, int], ...] = (
    (5000, 25),
    (2000, 10),
    (500, 5),
    (200, 2),
    (0, 1),
)

TickMode = Literal["nearest", "down", "up"]


def tick_size(price: float) -> int:
    """The tick size applying at `price`. Non-finite or non-positive input -> 1."""
    if not math.isfinite(price) or price <= 0:
        return 1
    for floor, tick in BANDS:
        if price >= floor:
            return tick
    return 1


def round_to_tick(price: float, mode: TickMode = "nearest") -> float:
    """Snap `price` onto a valid IDX tick."""
    if not math.isfinite(price) or price <= 0:
        return price

    def snap(p: float, tick: int) -> float:
        if mode == "down":
            n = math.floor(p / tick)
        elif mode == "up":
            n = math.ceil(p / tick)
        else:
            n = round(p / tick)
        return float(max(tick, n * tick))

    once = snap(price, tick_size(price))
    settled = snap(once, tick_size(once))
    return settled


def is_on_tick(price: float) -> bool:
    """Whether `price` already sits on a valid tick."""
    if not math.isfinite(price) or price <= 0:
        return False
    ts = tick_size(price)
    return price % ts == 0
