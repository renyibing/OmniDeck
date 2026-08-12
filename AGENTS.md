# OmniDeck Agent Guidance

Use the repository skill at `.agents/skills/omnideck-multi-device-control/SKILL.md` for any work involving device sessions, mobile drivers, monitor-wall UI, streams, AI scheduling, batch actions, health monitoring, or multi-device validation.

Preserve these non-negotiable rules:

- Every device owns isolated mutable runtime state.
- Batch goals create independent per-device task instances.
- Never broadcast one coordinate action across devices.
- AI observation is screenshot/event driven, not continuous video analysis.
- Layout and fullscreen changes never recreate device or agent sessions.
- Real-device actions require explicit target IDs and authorization.

Run `.agents/skills/omnideck-multi-device-control/scripts/validate_omnideck.sh` after relevant changes.
