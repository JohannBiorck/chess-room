-- Discovery only scans currently waiting rooms deliberately made public.
CREATE INDEX matches_open_waiting_created ON matches (created_at DESC, id)
  WHERE status='waiting' AND rules_config->>'visibility'='open';
