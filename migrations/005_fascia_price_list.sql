-- The fuller loadsheet export carries the distribution channel and the price
-- list type, so both can now take part in selection.
--
-- `price_list_type` is the fascia's SAP price list ('pltyp'). It sits between
-- store-specific and sales-organisation-wide in the precedence order. It is
-- NULL until we know a fascia actually uses one — a NULL never matches, so a
-- price-list row cannot be picked up by accident.

ALTER TABLE fascias
    ADD COLUMN IF NOT EXISTS price_list_type      TEXT,
    -- SAP distribution channel ('vtweg'). G1 is the UK retail channel.
    ADD COLUMN IF NOT EXISTS distribution_channel TEXT NOT NULL DEFAULT 'G1';
