export const SERVICE_OUTPUT_PATTERN = /Service ([0-9a-f\-]{36}|[0-9a-z\-]{4}) found: start handle ([0-9a-f]+), end_handle ([0-9a-f]+)/;

export const CHARACTERISTIC_DEFINITION_OUTPUT_PATTERN = /Characteristic ([0-9a-f\-]{36}|[0-9a-z\-]{4}) found: handle ([0-9a-f]+)/;
export const CHARACTERISTIC_PROPERTIES_PATTERN = /(\[write\]|\[write w\/w rsp\]|\[read\]|\[notify\]|\[indicate\])/;