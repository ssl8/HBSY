-- A repeated goods-receipt document must not increase stock twice for the same drug.
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_receipt_document_drug
    ON pharmacy.stock_movements(drug_id, lower(reference))
    WHERE movement_type = 'Receipt' AND reference IS NOT NULL;
