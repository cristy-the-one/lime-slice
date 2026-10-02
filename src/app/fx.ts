/** Late-bound calls between app modules. Each module registers its own functions; nothing imports main.ts. */
export const fx: Record<string, any> = {};
