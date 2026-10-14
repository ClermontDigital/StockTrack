## 0.1.1

Fixes to the card, from a review.

- **The popup stays open when the dashboard moves the card**, as a masonry view does when a phone is turned,
  and stays on the day that was open.
- **Selecting text in the popup** and letting go outside it no longer closes it. A tap outside it still does.
- **Bigger tap areas**: the previous and next day, All days, delete, Add and Save, close and the calendar
  button each take a tap anywhere in 44 px.
- **Screen readers** hear the new count, or how many were used on the day being edited, from one live region
  that isn't redrawn.
- **Text on the accent** is dark or light to suit it, so a dark accent from a theme or card-mod stays readable
  on the buttons, the stickers, today's date and each day's canister.
- **Older iPhones** (iOS before 16.2, which can't mix colours in CSS) get plain tints instead of missing ones,
  and used days keep their fill.

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
