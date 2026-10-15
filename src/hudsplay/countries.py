from __future__ import annotations

from functools import lru_cache

import pycountry


@lru_cache(maxsize=512)
def to_iso(name: str | None) -> str | None:
    """Country name (iRacing flair) -> lowercase ISO alpha-2 code for flag images."""
    if not name:
        return None
    try:
        return pycountry.countries.lookup(name).alpha_2.lower()
    except LookupError:
        pass
    try:
        return pycountry.countries.search_fuzzy(name)[0].alpha_2.lower()
    except LookupError:
        return None
