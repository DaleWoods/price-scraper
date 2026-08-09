-- Remove columns nothing reads or writes any more.
--
-- products.our_price predates per-fascia pricing: prices now live in
-- fascia_prices, and every query that shows "our price" joins the fascia being
-- compared against. Leaving the column invited exactly the bug it caused —
-- routes/matches.ts selected it and silently returned NULL for every row.
ALTER TABLE products DROP COLUMN IF EXISTS our_price;

-- Left by the SAP price loadsheet importer, which the Google feed replaced.
-- The feed has no condition types, price lists or validity windows.
ALTER TABLE fascias
    DROP COLUMN IF EXISTS price_list_type,
    DROP COLUMN IF EXISTS distribution_channel;

ALTER TABLE fascia_prices
    DROP COLUMN IF EXISTS valid_from,
    DROP COLUMN IF EXISTS valid_to,
    -- Provenance that stopped being informative: every feed row wrote the same
    -- two constants.
    DROP COLUMN IF EXISTS source_kschl,
    DROP COLUMN IF EXISTS source_werks;
