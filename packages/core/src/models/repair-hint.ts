export interface RepairHint {
  readonly kind: "exact-replacement";
  readonly targetText: string;
  readonly replacementText: string;
  readonly occurrenceIndexes: number[];
  readonly context: string;
}
