import { describe, expect, it } from 'vitest'

import { AUTOMATION_TEMPLATES, localizeAutomationTemplate } from './templates'
import { validateRunFrequency } from './validate'

const all = Object.values(AUTOMATION_TEMPLATES)

describe('automation templates', () => {
  it('every template declares a valid run frequency', () => {
    for (const t of all) {
      expect(validateRunFrequency(t.run_frequency, t.cooldown_hours), t.slug).toEqual([])
    }
  })

  it('no message-triggered template answers every message', () => {
    for (const t of all) {
      if (t.trigger_type === 'new_message_received' || t.trigger_type === 'keyword_match') {
        expect(t.run_frequency, t.slug).not.toBe('every_time')
      }
    }
  })

  it('out of office uses the account business hours and replies at most every 12 h', () => {
    const t = AUTOMATION_TEMPLATES.out_of_office
    expect(t.steps[0]).toMatchObject({ step_type: 'condition', step_config: { subject: 'business_hours' } })
    expect(t.steps[1]).toMatchObject({ step_type: 'send_message', parent_index: 0, branch: 'no' })
    expect(t).toMatchObject({ run_frequency: 'cooldown', cooldown_hours: 12 })
  })

  it('follow-up starts from silence after the team replied and cancels on reply', () => {
    const t = AUTOMATION_TEMPLATES.follow_up_reminder
    expect(t.trigger_type).toBe('conversation_inactive')
    expect(t.trigger_config).toMatchObject({ last_from: 'agent' })
    expect(t.steps.find((s) => s.step_type === 'wait')?.step_config).toMatchObject({ cancel_on_reply: true })
  })

  it('welcome has no half-configured tag step that would block activation', () => {
    const t = AUTOMATION_TEMPLATES.welcome_message
    expect(t.run_frequency).toBe('once_per_contact')
    expect(t.steps.some((s) => s.step_type === 'add_tag')).toBe(false)
  })

  it('translates every template message to pt-BR', () => {
    for (const t of all) {
      const pt = localizeAutomationTemplate(t, 'pt-BR')
      pt.steps.forEach((s, i) => {
        const original = t.steps[i].step_config as { text?: string }
        const translated = s.step_config as { text?: string }
        if (original.text) expect(translated.text, `${t.slug}[${i}]`).not.toBe(original.text)
      })
    }
  })
})
