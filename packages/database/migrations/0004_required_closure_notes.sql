-- Explicit NULL checks close PostgreSQL CHECK's three-valued-logic gap.
ALTER TABLE opportunities ADD CONSTRAINT opportunities_lost_reason_required
 CHECK(stage <> 'lost' OR (lost_reason IS NOT NULL AND length(trim(lost_reason)) > 0));
ALTER TABLE opportunity_tasks ADD CONSTRAINT opportunity_tasks_completion_note_required
 CHECK(status <> 'completed' OR (completion_note IS NOT NULL AND length(trim(completion_note)) > 0));
