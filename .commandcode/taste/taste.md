# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# datetime
- Never mix UTC and local DateTime objects in the same calculation. Convert UTC to local zone first (using .setZone), perform all arithmetic in local time, then convert back to UTC via .toUTC().toISO(). Confidence: 0.70
- Use luxon (DateTime.fromISO, DateTime.now().setZone, .toUTC().toISO()) for ALL datetime operations. Never use raw Date, Date.now(), toISOString(), getHours(), or getMinutes(). Confidence: 0.85

