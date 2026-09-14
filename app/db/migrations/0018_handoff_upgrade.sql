-- Ranking a handoff priority, so an open queue entry can be upgraded.
--
-- A conversation holds one open handoff: one conversation is one job, and two
-- entries means somebody picks one without knowing the other exists. The
-- consequence was found live. A conversation already had an escalated handoff
-- about the highest-priced car; the customer then asked for a discount; the
-- insert hit `on conflict do nothing` and the discount was never recorded. The
-- salesperson would have opened a stale summary.
--
-- Lower number is more serious, matching the queue's own ordering.
CREATE OR REPLACE FUNCTION public.vyra_priority_rank(p text)
RETURNS int
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT CASE p WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.vyra_priority_rank(text) TO vyra_app;
