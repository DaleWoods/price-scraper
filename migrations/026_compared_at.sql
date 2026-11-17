-- When each product was last looked for at every competitor, whether or not
-- one was found. All products uses it to tell "not checked yet" apart from
-- "checked, and no competitor sells it" -- two very different answers that
-- both look like an empty row.
ALTER TABLE products ADD COLUMN IF NOT EXISTS compared_at TIMESTAMPTZ;

-- Everything already looked up, or already part of a run, has been compared.
UPDATE products SET compared_at = looked_up_at
 WHERE compared_at IS NULL AND looked_up_at IS NOT NULL;
UPDATE products p SET compared_at = sub.at
  FROM (SELECT product_id, max(created_at) AS at FROM scrape_run_items
         WHERE product_id IS NOT NULL GROUP BY product_id) sub
 WHERE p.id = sub.product_id AND p.compared_at IS NULL;
