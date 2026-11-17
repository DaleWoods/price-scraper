-- Concentrate on the three competitors that matter most: Beaverbrooks,
-- Ernest Jones and Fraser Hart. The rest stay defined and can be switched
-- back on in Admin.
UPDATE competitors SET enabled = (slug IN ('beaverbrooks', 'ernest-jones', 'fraser-hart'));

-- Repair what was read from their pages before the reader was corrected.
--
-- 1. A reference with a slash was stored as it appears inside page data,
--    with the slash written as a backslash, "u002F": "GS05750" || that ||
--    "01", which can never equal our "GS05750/01". chr(92) is the backslash,
--    spelt out so nothing between this file and the database can alter it.
UPDATE competitor_products
   SET mpn = replace(replace(mpn, chr(92) || 'u002F', '/'), chr(92) || 'u002f', '/')
 WHERE position(chr(92) || 'u002' in mpn) > 0;

-- 2. A barcode their own site publishes mangled by a spreadsheet
--    ("5.01848E+12") is not a barcode.
UPDATE competitor_products SET gtin = NULL WHERE gtin ~* '^\d(\.\d+)?E\+\d+$';

-- 3. Pages read before the manufacturer's reference was looked for hold the
--    retailer's own stock number in its place. Forgotten here, so the next
--    check reads them again, properly.
DELETE FROM competitor_products
 WHERE status = 'ok' AND mpn IS NOT NULL AND sku IS NOT NULL
   AND ident_key(mpn) = ident_key(sku);
