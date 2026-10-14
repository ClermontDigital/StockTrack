## 0.1.0

First release.

- **A resource per config entry**, such as toilet paper or tinned food, each with its own unit, icon and
  Running low level.
- **The card**: take one, put one back, tap the number for a stocktake, the use per week and the supply left,
  and a calendar of days with restocks and stocktakes marked, where any day can be fixed or filled in, and a
  CSV export. Compact (the calendar in a popup) or calendar layout.
- **A log of takes, restocks, put-backs and stocktakes.** What's in storage replays it in order; a stocktake
  sets the count, and tracking starts at the first one.
- **Sensors** for what's in storage, what's been used today, in the last 7 days, this month and in all, the
  use per week, the days between, the supply left, the last take and the last restock. A **Running low**
  binary sensor, **Take one** and **Put one back** buttons, and a **Stocktake** number.
- **Actions** `stock_track.take`, `stock_track.restock` and `stock_track.stocktake`, each with an optional
  date and note.
- Open cards update when the log changes anywhere. Read-only users can look but not log.
- Needs Home Assistant 2025.2 or newer.
