/** Every ceiling of the saved-view config and of how many views there can be. */
export const VIEW_LIMITS = {
  maxConfigBytes: 16 * 1024,
  maxJsonDepth: 10,
  maxSortKeys: 3,
  maxColumns: 20,
  /** a board card / calendar chip shows a few fields, not a table row */
  maxCardFields: 8,
  maxNameLength: 120,
  maxPersonalPerUserPerWorkspace: 100,
  maxSharedPerWorkspace: 50,
  maxPosition: 100_000,
} as const;
