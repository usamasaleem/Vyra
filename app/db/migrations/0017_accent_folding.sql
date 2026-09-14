-- Matching a car the customer spelled without its accent.
--
-- Live, a customer asked for a "Huracan". The fleet holds "Huracán", ilike
-- found nothing, and the agent told them we did not have that car. It was
-- sitting in the fleet with a confirmed rate. The same failure as the earlier
-- "yellow Ferrari" one: a sentence that is false, sounds authoritative, and
-- costs a booking.
--
-- Nobody types the accent. Expecting them to is not a requirement, it is a bug.
--
-- translate() rather than the unaccent extension: unaccent is not available
-- everywhere this schema runs, including the PGlite instance the tests use, and
-- a search that behaves differently in tests than in production is worse than
-- one that folds a slightly smaller set of characters.
--
-- IMMUTABLE and not STRICT-dependent, so it can be indexed if the fleet ever
-- grows past the point where a scan is fine.
CREATE OR REPLACE FUNCTION public.vyra_fold(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT translate(
    lower(input),
    'áàâäãåéèêëíìîïóòôöõøúùûüýñçšž',
    'aaaaaaeeeeiiiioooooouuuuyncsz'
  )
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.vyra_fold(text) TO vyra_app;
