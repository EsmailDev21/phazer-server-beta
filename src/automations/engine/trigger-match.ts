import { getTrigger } from '../registry';
import { Trigger } from '../dsl/rule.types';
import { RuleEvent } from './rule-event';

/**
 * Pure: does this event fire this trigger? (Scope and conditions are checked separately.)
 * What each trigger matches on is its descriptor's `match` (step 5.8).
 */
export function matchesTrigger(trigger: Trigger, event: RuleEvent): boolean {
  return getTrigger(trigger.type)?.match(trigger, event) ?? false;
}
