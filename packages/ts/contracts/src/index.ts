import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";

import platformEventSchema from "../schemas/platform-event.v1.schema.json" with { type: "json" };
import type { PlatformEventV1 } from "./generated/platform-event-v1.js";

export type { PlatformEventV1 } from "./generated/platform-event-v1.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = addFormatsModule as unknown as FormatsPlugin;
addFormats(ajv);
const platformEventValidator =
  ajv.compile<PlatformEventV1>(platformEventSchema);

export function isPlatformEventV1(value: unknown): value is PlatformEventV1 {
  return platformEventValidator(value);
}
