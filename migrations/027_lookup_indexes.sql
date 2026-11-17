-- Finding our products from an uploaded list. A list of 249 SKUs sat at
-- "Finding our products... 0 of 249": each value was looked for by SKU,
-- barcode and reference in one query, which no index could serve, so every
-- value scanned every product. These let each kind of lookup use an index.
CREATE INDEX IF NOT EXISTS products_sku_lower_idx ON products (lower(internal_sku));
CREATE INDEX IF NOT EXISTS products_ean_key_idx ON products (gtin_key(ean_mpn)) WHERE ean_mpn IS NOT NULL;
