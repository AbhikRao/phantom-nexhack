// TEMPLATE STUB — replaced by PHANTOM's generator with the inferred contract. Exists so the template typechecks standalone.
import type { ResourceSchema } from './validate.ts';

export const BUILD_ID = 'template';

export const RESOURCES: Record<string, ResourceSchema> = {
  tasks: { fields: { title: { types: ['string'] }, status: { types: ['string'] } }, required: ['title'] },
};
