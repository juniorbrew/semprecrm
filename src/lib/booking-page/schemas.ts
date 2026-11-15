import { z } from 'zod'

import { isValidSlug, SLUG_MAX } from './core'

const uuidList = z.array(z.string().uuid()).max(200).nullable()
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null))

/** Settings → Página de agendamento (admin). */
export const bookingPageSchema = z.object({
  enabled: z.boolean(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(SLUG_MAX)
    .refine(isValidSlug, 'Endereço inválido: use letras minúsculas, números e hífen (3 a 40).'),
  title: optText(80),
  intro: optText(500),
  whatsapp_number: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v === '' || /^[1-9]\d{9,14}$/.test(v), 'Número do WhatsApp inválido (com DDI e DDD).')
    .transform((v) => v || null)
    .nullable(),
  show_prices: z.boolean(),
  service_ids: uuidList,
  resource_ids: uuidList,
  min_notice_minutes: z.number().int().min(0).max(43200).nullable(),
  max_days_ahead: z.number().int().min(1).max(365).nullable(),
  max_future_per_contact: z.number().int().min(1).max(10),
  allow_cancel: z.boolean(),
  allow_reschedule: z.boolean(),
  change_limit_hours: z.number().int().min(0).max(720),
})

export type BookingPageInput = z.infer<typeof bookingPageSchema>
