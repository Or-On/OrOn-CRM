"""Generate the authoritative deterministic control-api OpenAPI document."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from control_api.app import create_app
from or_on_platform.config import PlatformSettings


class SchemaProbe:
    async def is_ready(self) -> bool:
        return True

    async def close(self) -> None:
        return None


_HEADER = "// Generated from control-api OpenAPI. Do not edit by hand.\n\n"


def generate_openapi() -> dict[str, Any]:
    settings = PlatformSettings(_env_file=None, PLATFORM_ENV="test", PLATFORM_SERVICE="contracts")
    app = create_app(settings=settings, database_probe=SchemaProbe())
    return app.openapi()


def _typescript_type(schema: dict[str, Any]) -> str:
    reference = schema.get("$ref")
    if isinstance(reference, str):
        return reference.rsplit("/", maxsplit=1)[-1]
    if "const" in schema:
        return json.dumps(schema["const"])
    enumeration = schema.get("enum")
    if isinstance(enumeration, list):
        return " | ".join(json.dumps(value) for value in enumeration)
    for union_key in ("anyOf", "oneOf"):
        union = schema.get(union_key)
        if isinstance(union, list):
            return " | ".join(_typescript_type(item) for item in union)
    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        return " | ".join(_typescript_type({**schema, "type": item}) for item in schema_type)
    if schema_type == "array":
        items = schema.get("items", {})
        return f"Array<{_typescript_type(items)}>"
    if schema_type == "object":
        return "Record<string, unknown>"
    if not isinstance(schema_type, str):
        return "unknown"
    return {
        "boolean": "boolean",
        "integer": "number",
        "null": "null",
        "number": "number",
        "string": "string",
    }.get(schema_type, "unknown")


def generate_types(document: dict[str, Any]) -> str:
    lines = [_HEADER.rstrip(), ""]
    schemas = document.get("components", {}).get("schemas", {})
    for name in sorted(schemas):
        schema = schemas[name]
        if schema.get("type") != "object" or not isinstance(schema.get("properties"), dict):
            lines.append(f"export type {name} = {_typescript_type(schema)};")
            lines.append("")
            continue
        required = set(schema.get("required", []))
        lines.append(f"export interface {name} {{")
        for property_name, property_schema in sorted(schema["properties"].items()):
            marker = "" if property_name in required else "?"
            lines.append(
                f"  readonly {property_name}{marker}: {_typescript_type(property_schema)};"
            )
        lines.extend(["}", ""])
    return "\n".join(lines)


def _method_name(operation_id: str) -> str:
    pieces = re.split(r"[_-]+", operation_id)
    return pieces[0] + "".join(piece.capitalize() for piece in pieces[1:])


def generate_client(document: dict[str, Any]) -> str:
    operations: list[tuple[str, str, str, str, str | None, list[tuple[str, str]]]] = []
    for path, path_item in sorted(document.get("paths", {}).items()):
        for http_method in ("get", "post"):
            operation = path_item.get(http_method)
            if not isinstance(operation, dict):
                continue
            response_schema = operation["responses"]["200"]["content"]["application/json"]["schema"]
            response_type = _typescript_type(response_schema)
            request_body = operation.get("requestBody")
            request_type = None
            if isinstance(request_body, dict):
                request_schema = request_body["content"]["application/json"]["schema"]
                request_type = _typescript_type(request_schema)
            declared = {
                parameter["name"]: _typescript_type(parameter.get("schema", {}))
                for parameter in [
                    *path_item.get("parameters", []),
                    *operation.get("parameters", []),
                ]
                if parameter.get("in") == "path"
            }
            path_parameters = []
            for name in re.findall(r"\{([^}]+)\}", path):
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) or name not in declared:
                    raise ValueError("every path placeholder must have a declared parameter")
                path_parameters.append((name, declared[name]))
            operations.append(
                (
                    _method_name(operation["operationId"]),
                    path,
                    response_type,
                    http_method.upper(),
                    request_type,
                    path_parameters,
                )
            )

    imported = ", ".join(
        sorted(
            {
                schema_type
                for _, _, response_type, _, request_type, _ in operations
                for schema_type in (response_type, request_type)
                if schema_type is not None
            }
        )
    )
    lines = [
        _HEADER.rstrip(),
        "",
        f'import type {{ {imported} }} from "./schema";',
        "",
        "export interface ApiResponse<T> {",
        "  readonly data: T;",
        "  readonly ok: boolean;",
        "  readonly status: number;",
        "}",
        "",
        (
            "export type FetchLike = (input: string | URL | Request, "
            "init?: RequestInit) => Promise<Response>;"
        ),
        "",
        "export class GeneratedControlApiClient {",
        "  public constructor(",
        "    private readonly baseUrl: string,",
        "    private readonly fetcher: FetchLike = fetch,",
        "  ) {}",
        "",
    ]
    for method_name, path, response_type, http_method, request_type, path_parameters in operations:
        arguments = []
        target = json.dumps(path)
        if path_parameters:
            fields = "; ".join(f"readonly {name}: {kind}" for name, kind in path_parameters)
            arguments.append(f"parameters: {{ {fields} }}")
            escaped = path.replace("`", "\\`").replace("${", "\\${")
            for name, _ in path_parameters:
                escaped = escaped.replace(
                    "{" + name + "}", "${encodeURIComponent(String(parameters." + name + "))}"
                )
            target = "`" + escaped + "`"
        if request_type is not None:
            arguments.append(f"body: {request_type}")
        signature = ", ".join(arguments)
        if request_type is None:
            lines.extend(
                [
                    f"  public async {method_name}({signature}): "
                    f"Promise<ApiResponse<{response_type}>> {{",
                    f"    return this.request<{response_type}>({target});",
                    "  }",
                    "",
                ]
            )
        else:
            lines.extend(
                [
                    (
                        f"  public async {method_name}({signature}): "
                        f"Promise<ApiResponse<{response_type}>> {{"
                    ),
                    f"    return this.request<{response_type}>({target}, {{",
                    f'      method: "{http_method}",',
                    '      headers: { "content-type": "application/json" },',
                    "      body: JSON.stringify(body),",
                    "    });",
                    "  }",
                    "",
                ]
            )
    lines.extend(
        [
            (
                "  private async request<T>(path: string, init?: RequestInit): "
                "Promise<ApiResponse<T>> {"
            ),
            "    const url = new URL(path, this.baseUrl);",
            "    const response =",
            "      init === undefined ? await this.fetcher(url) : await this.fetcher(url, init);",
            "    return {",
            "      data: (await response.json()) as T,",
            "      ok: response.ok,",
            "      status: response.status,",
            "    };",
            "  }",
            "}",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    package = Path(__file__).parents[1] / "packages" / "ts" / "api-client"
    generated = package / "src" / "generated"
    generated.mkdir(parents=True, exist_ok=True)
    document = generate_openapi()
    (package / "openapi.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    (generated / "schema.ts").write_text(generate_types(document), encoding="utf-8", newline="\n")
    (generated / "client.ts").write_text(generate_client(document), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
