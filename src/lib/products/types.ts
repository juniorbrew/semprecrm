// Product catalog and deal line items (migration 104).

export interface Product {
  id: string
  account_id: string
  name: string
  code: string | null
  unit_price: number
  description: string | null
  archived_at: string | null
}

/** One line of a deal. name and unit_price are copies taken when it was added. */
export interface DealItem {
  id: string
  account_id: string
  deal_id: string
  product_id: string | null
  name: string
  unit_price: number
  quantity: number
  discount_pct: number
  position: number
  /** Computed by the database: round(quantity * unit_price * (1 - discount / 100), 2). */
  line_total: number
}

/** Validated values of a line, ready to send. */
export interface ItemValues {
  name: string
  unit_price: number
  quantity: number
  discount_pct: number
}

export interface ProductValues {
  name: string
  code: string | null
  unit_price: number
  description: string | null
}
