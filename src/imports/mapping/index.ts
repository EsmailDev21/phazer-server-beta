export * from './mapping.types';
export { priorityKey, lookupPriority, CATEGORY_COLOR } from './mapping.tables';
export { buildInventory, parseInventory, emptyInventory, InventoryError, foldEmail } from './mapping.inventory';
export { parseConfig, checkConfig, CONFIG_LIMITS } from './mapping.config';
export { suggest, suggestStatus } from './mapping.suggest';
export { resolve, Resolution } from './mapping.resolve';
export { applyMapping, mappedTaskHash } from './mapping.apply';
