import type { EndpointGroup } from "../store/service/types";
import { translateAppString } from "../lib/app-language";
import type { StringKey } from "../i18n/catalog";

export const GROUP_ORDER: ReadonlyArray<EndpointGroup> = [
  "aggregator",
  "overseas",
  "china",
  "local",
  "codingPlan",
] as const;

const GROUP_LABEL_KEYS: Record<EndpointGroup, StringKey> = {
  overseas: "services.group.overseas",
  china: "services.group.china",
  aggregator: "services.group.aggregator",
  local: "services.group.local",
  codingPlan: "services.group.codingPlan",
};

const GROUP_DESCRIPTION_KEYS: Partial<Record<EndpointGroup, StringKey>> = {
  aggregator: "services.group.aggregatorDescription",
};

const GROUP_SHORT_LABEL_KEYS: Record<EndpointGroup, StringKey> = {
  overseas: "services.group.shortOverseas",
  china: "services.group.shortChina",
  aggregator: "services.group.shortAggregator",
  local: "services.group.shortLocal",
  codingPlan: "services.group.codingPlan",
};

export function getGroupLabel(group: EndpointGroup): string {
  return translateAppString(GROUP_LABEL_KEYS[group]);
}

export function getGroupDescription(group: EndpointGroup): string | null {
  const key = GROUP_DESCRIPTION_KEYS[group];
  return key ? translateAppString(key) : null;
}

export function getGroupShortLabel(group: EndpointGroup): string {
  return translateAppString(GROUP_SHORT_LABEL_KEYS[group]);
}
