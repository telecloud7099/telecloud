import time

CACHE_TTL = 3600  # 1 hour

_cache: dict[str, tuple] = {}  # key → (data, timestamp)


def cache_get(key: str):
    if key in _cache:
        data, ts = _cache[key]
        if time.time() - ts < CACHE_TTL:
            return data
        del _cache[key]
    return None


def cache_set(key: str, data):
    _cache[key] = (data, time.time())


def cache_invalidate(phone: str):
    keys = [k for k in _cache if k.startswith(f"{phone}:")]
    for k in keys:
        del _cache[k]


def cache_sweep():
    now = time.time()
    expired = [k for k, (_, ts) in _cache.items() if now - ts >= CACHE_TTL]
    for k in expired:
        del _cache[k]
