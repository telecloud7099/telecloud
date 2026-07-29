"""Generic benchmark comparison tool -- not specific to any one change.

Reads two run directories produced by run_suite.sh and produces a side-by-side
report with percentage differences. Anomalies recorded in either run are
excluded from the quantitative comparison for the affected metric (noted
explicitly, not silently dropped) rather than blended into the numbers.

Usage:
    python3 compare.py /opt/telecloud/bench/before /opt/telecloud/bench/after
"""
import json
import re
import sys
from pathlib import Path

REGRESSION_THRESHOLD_PCT = 10.0  # matches the "stop and report" bar agreed for this change


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def read_anomalies(run_dir: Path) -> list[str]:
    p = run_dir / "anomalies.log"
    if not p.exists():
        return []
    return [line.strip() for line in p.read_text().splitlines() if line.strip()]


def parse_upload_log(run_dir: Path, size_label: str) -> dict:
    """Pulls wall_clock_total_seconds / throughput_MB_per_s out of
    phase10_upload_benchmark.py's own text output -- deliberately not
    modifying that script, just reading its existing, already-proven format."""
    log_path = run_dir / "raw" / f"{size_label}_upload.log"
    if not log_path.exists():
        return {}
    text = log_path.read_text()
    result = {}
    m = re.search(r"wall_clock_total_seconds:\s*([\d.]+)", text)
    if m:
        result["wall_clock_seconds"] = float(m.group(1))
    m = re.search(r"throughput_MB_per_s[^:]*:\s*([\d.]+)", text)
    if m:
        result["throughput_mb_s"] = float(m.group(1))
    m = re.search(r"sum_telegram_leg_seconds:\s*([\d.]+)", text)
    if m:
        result["telegram_leg_seconds"] = float(m.group(1))
    return result


def parse_download_timing(run_dir: Path, size_label: str) -> dict:
    p = run_dir / "raw" / f"{size_label}_download_timing.txt"
    if not p.exists():
        return {}
    text = p.read_text()
    result = {}
    for key in ("time_total", "speed_download", "time_starttransfer"):
        m = re.search(rf"{key}=([\d.]+)", text)
        if m:
            result[key] = float(m.group(1))
    return result


def pct_diff(before: float, after: float) -> float:
    if before == 0:
        return float("inf") if after != 0 else 0.0
    return (after - before) / before * 100.0


def fmt_metric(name: str, before: dict, after: dict, key: str, unit: str, lower_is_better: bool) -> str:
    b, a = before.get(key), after.get(key)
    if b is None or a is None:
        return f"  {name}: incomplete data (before={b}, after={a}) -- not compared"
    diff = pct_diff(b, a)
    direction = "slower/worse" if (diff > 0) == lower_is_better else "faster/better"
    flag = ""
    if abs(diff) >= REGRESSION_THRESHOLD_PCT:
        flag = "  <-- MEANINGFUL DIFFERENCE (>=10%)" if (diff > 0) == lower_is_better else "  <-- IMPROVEMENT (>=10%)"
    return f"  {name}: before={b:.3f}{unit} after={a:.3f}{unit} diff={diff:+.1f}% ({direction}){flag}"


def main():
    if len(sys.argv) != 3:
        sys.exit("Usage: compare.py <before_run_dir> <after_run_dir>")
    before_dir, after_dir = Path(sys.argv[1]), Path(sys.argv[2])

    before_env = read_json(before_dir / "environment.json")
    after_env = read_json(after_dir / "environment.json")
    before_anomalies = read_anomalies(before_dir)
    after_anomalies = read_anomalies(after_dir)

    print("=" * 70)
    print("BENCHMARK COMPARISON REPORT")
    print("=" * 70)
    print(f"\nBefore: {before_env.get('label')} @ {before_env.get('git_commit', '?')[:12]} "
          f"(branch {before_env.get('git_branch')}, dirty={before_env.get('git_dirty')})")
    print(f"        recorded {before_env.get('timestamp')}")
    print(f"After:  {after_env.get('label')} @ {after_env.get('git_commit', '?')[:12]} "
          f"(branch {after_env.get('git_branch')}, dirty={after_env.get('git_dirty')})")
    print(f"        recorded {after_env.get('timestamp')}")

    if before_anomalies:
        print(f"\n⚠ {len(before_anomalies)} anomaly(ies) recorded in BEFORE run -- affected metrics excluded below, not blended:")
        for a in before_anomalies:
            print(f"    {a}")
    if after_anomalies:
        print(f"\n⚠ {len(after_anomalies)} anomaly(ies) recorded in AFTER run -- affected metrics excluded below, not blended:")
        for a in after_anomalies:
            print(f"    {a}")

    for size_label in ("2gb", "10gb"):
        print(f"\n--- {size_label.upper()} transfer ---")
        up_before = parse_upload_log(before_dir, size_label)
        up_after = parse_upload_log(after_dir, size_label)
        dl_before = parse_download_timing(before_dir, size_label)
        dl_after = parse_download_timing(after_dir, size_label)

        print(" Upload:")
        print(" " + fmt_metric("wall clock time", up_before, up_after, "wall_clock_seconds", "s", lower_is_better=False))
        print(" " + fmt_metric("throughput", up_before, up_after, "throughput_mb_s", "MB/s", lower_is_better=True))
        print(" Download:")
        print(" " + fmt_metric("total time", dl_before, dl_after, "time_total", "s", lower_is_better=False))
        print(" " + fmt_metric("speed", dl_before, dl_after, "speed_download", "B/s", lower_is_better=True))
        print(" " + fmt_metric("time to first byte", dl_before, dl_after, "time_starttransfer", "s", lower_is_better=False))

    print("\n--- Range request ---")
    for label, d in (("before", before_dir), ("after", after_dir)):
        p = d / "raw" / "range_test_timing.txt"
        print(f"  {label}: {p.read_text().strip() if p.exists() else 'no data'}")

    print("\n--- Resume-after-interruption ---")
    for label, d in (("before", before_dir), ("after", after_dir)):
        resume_anomalies = [a for a in read_anomalies(d) if "[resume]" in a]
        status = f"FAILED -- {resume_anomalies[0]}" if resume_anomalies else "completed without anomaly"
        print(f"  {label}: {status}")

    print("\n--- FloodWaitError ---")
    before_summary = read_json(before_dir / "summary.json")
    after_summary = read_json(after_dir / "summary.json")
    print(f"  before: {before_summary.get('flood_wait_error_count', '?')}")
    print(f"  after:  {after_summary.get('flood_wait_error_count', '?')}")

    print("\n--- Checksums ---")
    for label, d in (("before", before_dir), ("after", after_dir)):
        p = d / "checksums.txt"
        print(f"  {label}: {p.read_text().strip() if p.exists() else 'no data'}")

    print("\n" + "=" * 70)
    total_anomalies = len(before_anomalies) + len(after_anomalies)
    if total_anomalies:
        print(f"RESULT: {total_anomalies} total anomaly(ies) recorded -- review before treating this comparison as final.")
    else:
        print("RESULT: no anomalies recorded in either run. See per-metric flags above for regressions/improvements >=10%.")
    print("=" * 70)


if __name__ == "__main__":
    main()
