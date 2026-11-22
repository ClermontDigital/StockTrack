"""The rules, without Home Assistant."""
from datetime import date, datetime, timedelta, timezone

from custom_components.stock_track import engine

TODAY = date(2026, 10, 14)


BRISBANE = timezone(timedelta(hours=10))


def ev(day: date, kind: str, n: int, hour: int = 12, minute: int = 0, i: str = "", **extra) -> dict:
    """An event at `hour`:`minute` Brisbane time on `day`, stored in UTC as the integration stores it."""
    when = datetime(day.year, day.month, day.day, hour, minute, tzinfo=BRISBANE).astimezone(timezone.utc)
    return {"id": i or f"{day}{kind}{hour}{minute}", "ts": when.isoformat(timespec="seconds"),
            "date": day.isoformat(), "kind": kind, "n": n, **extra}


def test_the_household_starting_point():
    """8 rolls went into storage two days ago; today's stocktake found 37. The counter reads 37."""
    events = [ev(TODAY - timedelta(days=2), "add", 8), ev(TODAY, "count", 37, hour=19)]
    s = engine.stats(events, TODAY)
    assert s.in_storage == 37
    assert s.last_restock == TODAY - timedelta(days=2) and s.last_restock_amount == 8
    assert s.last_stocktake == TODAY and s.last_stocktake_count == 37
    # Tracking starts at the stocktake: the two days before weren't tracked, so they aren't zero-use days.
    assert s.tracking_since == TODAY and s.tracked_days == 1
    assert s.per_day is None and s.days_left is None
    assert s.used_total == 0


def test_a_take_after_the_stocktake_counts_down():
    events = [ev(TODAY, "count", 37, hour=19), ev(TODAY, "take", 1, hour=21)]
    s = engine.stats(events, TODAY)
    assert s.in_storage == 36 and s.used_today == 1 and s.used_total == 1


def test_a_stocktake_overrides_what_came_before_it():
    events = [ev(TODAY - timedelta(days=5), "add", 10), ev(TODAY - timedelta(days=3), "take", 2),
              ev(TODAY - timedelta(days=1), "count", 20), ev(TODAY, "take", 1)]
    assert engine.replay(events)[0] == 19


def test_a_backdated_take_before_the_last_stocktake_leaves_the_level_alone():
    events = [ev(TODAY, "count", 37, hour=19), ev(TODAY - timedelta(days=1), "take", 1)]
    assert engine.replay(events)[0] == 37
    assert engine.stats(events, TODAY).used_yesterday == 1


def test_no_stocktake_counts_from_the_restock_and_never_goes_negative():
    events = [ev(TODAY - timedelta(days=1), "add", 2), ev(TODAY, "take", 5)]
    assert engine.replay(events)[0] == 0
    assert engine.replay([])[0] is None


def test_takes_alone_leave_the_level_unknown():
    """Nobody has said how many there are, so it isn't zero, and it isn't running low."""
    events = [ev(TODAY, "take", 1, hour=9)]
    s = engine.stats(events, TODAY, low_level=6)
    assert s.in_storage is None and not s.running_low and s.used_today == 1
    assert engine.series(events, {}, TODAY, 1)[0]["level"] is None


def test_a_put_back_doesnt_start_the_count():
    """Never counted, then one put back: still unknown, not 1 (which would read as running low)."""
    events = [ev(TODAY, "add", 1, hour=9, put_back=True)]
    s = engine.stats(events, TODAY, low_level=6)
    assert s.in_storage is None and not s.running_low


def test_a_put_back_is_not_a_restock():
    events = [ev(TODAY - timedelta(days=2), "add", 8), ev(TODAY, "count", 37, hour=9),
              ev(TODAY, "add", 1, hour=10, put_back=True)]
    s = engine.stats(events, TODAY)
    assert s.in_storage == 38
    assert s.last_restock == TODAY - timedelta(days=2) and s.last_restock_amount == 8
    today = engine.series(events, {}, TODAY, 1)[0]
    assert today["added"] == 0 and today["returned"] == 1
    assert engine.day_record(events, {}, TODAY)["events"][-1]["put_back"] is True


def test_rates_are_worked_out_before_rounding():
    """One in 30 days: one every 30.0 days, and 100 in storage last 3000 days (not 30.3 and 3030)."""
    since = TODAY - timedelta(days=29)
    events = [ev(since, "count", 101, hour=9), ev(TODAY, "take", 1, hour=10)]
    s = engine.stats(events, TODAY)
    assert s.in_storage == 100 and s.days_between == 30.0 and s.days_left == 3000


def test_rates_need_a_week_of_tracking():
    since = TODAY - timedelta(days=5)
    events = [ev(since, "count", 30, hour=9), ev(TODAY - timedelta(days=2), "take", 1)]
    assert engine.stats(events, TODAY).per_day is None          # six days tracked
    s = engine.stats(events, TODAY + timedelta(days=1))          # seven
    assert s.tracked_days == 7 and s.per_day == round(1 / 7, 3)


def test_rates_over_the_last_30_days():
    since = TODAY - timedelta(days=59)
    events = [ev(since, "count", 100, hour=9)]
    events += [ev(TODAY - timedelta(days=d), "take", 1) for d in range(0, 60, 5)]   # one every five days
    s = engine.stats(events, TODAY)
    assert s.used_last_30_days == 6
    assert s.per_day == 0.2 and s.per_week == 1.4 and s.days_between == 5.0
    assert s.in_storage == 88 and s.days_left == 440


def test_running_low():
    events = [ev(TODAY, "count", 6, hour=9)]
    assert engine.stats(events, TODAY, low_level=6).running_low
    assert not engine.stats(events, TODAY, low_level=5).running_low
    assert not engine.stats(events, TODAY).running_low         # 0 = off
    assert not engine.stats([], TODAY, low_level=6).running_low   # nothing counted yet


def test_series_carries_the_level_through_quiet_days():
    events = [ev(TODAY - timedelta(days=10), "count", 20, hour=9), ev(TODAY - timedelta(days=3), "take", 2),
              ev(TODAY - timedelta(days=3), "add", 6)]
    rows = engine.series(events, {(TODAY - timedelta(days=3)).isoformat(): "Big shop"}, TODAY, 5)
    assert [r["date"] for r in rows] == [(TODAY - timedelta(days=d)).isoformat() for d in range(4, -1, -1)]
    assert [r["level"] for r in rows] == [20, 24, 24, 24, 24]
    assert rows[1]["used"] == 2 and rows[1]["added"] == 6 and rows[1]["note"] == "Big shop"
    assert all(r["tracked"] for r in rows)


def test_days_before_tracking_are_marked():
    rows = engine.series([ev(TODAY, "count", 37)], {}, TODAY, 3)
    assert [r["tracked"] for r in rows] == [False, False, True]
    assert [r["level"] for r in rows] == [None, None, 37]


def test_a_restock_before_the_first_stocktake_draws_no_level():
    """The household's start: 8 into storage on the 12th, 37 counted on the 14th. No jump from 8 to 37."""
    events = [ev(TODAY - timedelta(days=2), "add", 8), ev(TODAY, "count", 37, hour=19)]
    rows = engine.series(events, {}, TODAY, 3)
    assert [r["level"] for r in rows] == [None, None, 37] and rows[0]["added"] == 8


def test_day_record_says_which_entries_were_filled_in_later():
    events = [ev(TODAY, "take", 1, hour=12, i="b", backdated=True), ev(TODAY, "take", 1, hour=9, i="a")]
    day = engine.day_record(events, {}, TODAY)
    assert [e.get("backdated") for e in day["events"]] == [None, True]


def test_day_record_lists_the_day_in_order():
    events = [ev(TODAY, "take", 1, hour=21, i="b"), ev(TODAY, "count", 37, hour=19, i="a")]
    day = engine.day_record(events, {TODAY.isoformat(): "Inventory"}, TODAY)
    assert [e["id"] for e in day["events"]] == ["a", "b"]
    assert day["used"] == 1 and day["count"] == 37 and day["note"] == "Inventory"


def test_paused_days_run_from_start_to_end_and_an_open_pause_to_today():
    periods = [{"start": "2026-10-01", "end": "2026-10-02"}, {"start": "2026-10-13", "end": None}]
    assert engine.paused_days(periods, TODAY) == frozenset(
        {date(2026, 10, 1), date(2026, 10, 2), date(2026, 10, 13), date(2026, 10, 14)})


def test_paused_days_are_left_out_of_the_rates():
    """Two weeks at 1 a day, then a week away using nothing: the rate stays 1 a day while paused days are left out."""
    start = TODAY - timedelta(days=20)
    events = [ev(start, "count", 100, hour=7)] + [ev(start + timedelta(days=i), "take", 1) for i in range(14)]
    paused = frozenset(TODAY - timedelta(days=back) for back in range(0, 7))
    away = engine.stats(events, TODAY, paused=paused)
    assert away.per_day == 1.0 and away.per_week == 7.0 and away.days_between == 1.0
    assert away.tracked_days == 14 and away.paused
    assert away.days_left == away.in_storage                     # 86 left at 1 a day
    home = engine.stats(events, TODAY)
    assert home.per_day == round(14 / 21, 3) and not home.paused


def test_a_pause_does_not_count_towards_the_first_week():
    start = TODAY - timedelta(days=9)
    events = [ev(start, "count", 10, hour=7), ev(start, "take", 1)]
    paused = frozenset(TODAY - timedelta(days=back) for back in range(0, 5))
    s = engine.stats(events, TODAY, paused=paused)
    assert s.tracked_days == 5 and s.per_week is None            # 10 days since the stocktake, 5 of them away
    assert engine.stats(events, TODAY).per_week is not None


def test_takes_on_paused_days_still_count_in_the_totals_and_the_level():
    events = [ev(TODAY - timedelta(days=1), "count", 10, hour=7), ev(TODAY, "take", 2)]
    s = engine.stats(events, TODAY, paused=frozenset({TODAY}))
    assert s.used_today == 2 and s.used_total == 2 and s.in_storage == 8
