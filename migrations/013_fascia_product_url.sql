-- products.our_product_url is a single column, even though the same
-- internal_sku can be sold across more than one of our sites — that is the
-- whole reason fascia_prices exists for price. Every feed import overwrote
-- it for whichever fascia was imported last, so a URL pasted from a site
-- that was not the most recently imported 404'd against "Scan by URL" even
-- though it came straight from that site's own feed. product_url here is the
-- correct, per-fascia value; products.our_product_url stays as a fallback
-- for a product with no fascia_prices row (out of stock, or added by hand).
ALTER TABLE fascia_prices
    ADD COLUMN IF NOT EXISTS product_url TEXT;
