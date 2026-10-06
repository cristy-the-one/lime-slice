# Retraction length, speed, and tower

A filament can override the strategy retract length and the 30 mm/s retract feed. Both are left out of a slice until the user asks, so a request that omits them keeps the G-code it had before, including the cartesian lock in `crates/lime-slice-core/tests/cartesian_lock.rs`.

## Decisions

- `retractLength` and `retractSpeed` are plate settings, beside `flow`. An object that sets either is refused.
- They are not fields of the printer profile. The profile's debug digest is the preview token.
- Left out, the length stays the strategy: 0.35 mm on speed, 0.9 mm on toughness, blended in between. The feed stays `F1800`, which is 30 mm/s. The final 1 mm park retract keeps that length and uses the same feed.
- A set length replaces the planned length at emit. It does not change where a travel retracts. A set speed replaces the feed of retract, unretract, and the park. `30` is left out of the request, because that feed is already `F1800`.
- Contour and toolpath keys blank both. The cut and the paths do not move. Adding the fields still changes those Debug keys once, because they hash `Debug` of the settings, including `retract_length: None`.
- The tower is a generator beside `calibrate pa`. Each band is two posts. The travel between them retracts by that band's length. Saving a band writes the length onto the filament, and the speed when it is not 30 mm/s.
- Length is from 0 to 5 mm. Speed is from 5 to 80 mm/s. The tower defaults are 0.2 to 1.2 mm in steps of 0.2, at 30 mm/s, and each band is 5 mm tall. A range longer than 40 bands stops at 40.

## Cache keys

The disk cache hashes the client JSON. Leaving both fields out of that JSON leaves the disk key unchanged. `null` is a different JSON object, so a client that sends `null` instead of omitting the field gets a different disk key.

In-memory stage keys hash `Debug` of `SliceSettings`. Adding the fields changes that text once. The stage copies used for contours and toolpaths set them back to `None`, so turning a retract override on does not replan those stages.

## Wire

`retractLength` and `retractSpeed` are omitted when unused. A length outside 0 to 5 mm is refused: `retractLength 6 must be from 0 to 5`. A speed outside 5 to 80 mm/s is refused: `retractSpeed 100 must be from 5 to 80`.

The G-code header gains `; retract 1.200 mm at 30 mm/s` when a length is set, and names the speed when that is set too.

`lime-slice calibrate retract` writes the tower. The UI posts `/api/calibrate/retract`. The desktop app invokes `calibrate_retract`.

## UI

An expert Retraction group. The checkbox is off. On, two fields send the length and, when it is not 30, the speed. The same group generates the tower, lists the bands, and saves the chosen length onto the filament.
