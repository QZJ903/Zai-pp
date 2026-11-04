import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { createBackgroundErrorResponse } from '../core/messaging/background-error';
import {
  RUNTIME_COMMAND_CONTRACTS,
  type RuntimeErrorFamily,
  type RuntimePayloadPresence,
  type RuntimeRequestBoundary,
} from '../core/messaging/runtime-command-contracts';
import {
  CLIENT_ONLY_RUNTIME_COMMAND_TYPES,
  TYPED_RUNTIME_COMMAND_TYPES,
  createUnknownRuntimeCommandResponse,
  getRuntimeCommandOwner,
} from '../core/messaging/runtime-command-registry';
import { decodeRuntimeMessageEnvelope } from '../core/messaging/runtime-boundary';
import {
  RUNTIME_CURRENT_GAPS,
  RUNTIME_ERROR_FIXTURES,
  RUNTIME_NOTIFICATION_TYPES,
  RUNTIME_REQUEST_FIXTURES,
  RUNTIME_RESOLVED_BOUNDARY_CASES,
  RUNTIME_RESOLVED_ROUTING_CASES,
  RUNTIME_RESPONSE_FIXTURES,
  RUNTIME_TAB_RPC_TYPES,
  RUNTIME_TOPOLOGY,
} from './fixtures/runtime-contract/runtime';
import { findTypeAliasDeclaration, parseTypeScriptSource } from './helpers/typescript-source';

/**
 * 文档正文里用的是**英文数词**（`Sixty-three names are shared`）。
 *
 * ⚠️ 只收录 0–99 里会出现在这份文档中的那些；**超出表就查表失败**，不许静默通过
 * —— 数词写错与计数写错一样会让文档自相矛盾。`shared` 现在是 62，`declaredOnly` 是 2。
 */
const ENGLISH_NUMBER_WORDS: Record<number, string> = {
  0: 'Zero', 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five',
  6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten',
  11: 'Eleven', 12: 'Twelve', 13: 'Thirteen', 14: 'Fourteen', 15: 'Fifteen',
  16: 'Sixteen', 17: 'Seventeen', 18: 'Eighteen', 19: 'Nineteen', 20: 'Twenty',
  27: 'Twenty-seven', 30: 'Thirty', 56: 'Fifty-six', 59: 'Fifty-nine',
  60: 'Sixty', 62: 'Sixty-two', 63: 'Sixty-three', 64: 'Sixty-four',
  65: 'Sixty-five', 89: 'Eighty-nine', 91: 'Ninety-one',
};

const backgroundSource = readFileSync('entrypoints/background.ts', 'utf8');
const typesSource = readFileSync('core/types.ts', 'utf8');
const inventorySource = readFileSync('docs/compatibility/runtime-command-inventory.md', 'utf8');
const COMMAND_GROUP_SECTIONS = [
  ['Group A — Typed seam bootstrap (2)', 2],
  ['Group B — Persistence, library, and local preferences (41)', 41],
  ['Group C — MCP, tool, browser control, and sandbox (30)', 30],
  ['Group D — DOM task lifecycle (3)', 3],
  ['Group E — Automation, usage, models, and lifecycle closure (13)', 13],
] as const;

describe('runtime command compatibility contract', () => {
  it('matches the live router, MessageAction union, and checked-in human inventory', () => {
    const typedContracts: RuntimeCaseContract[] = TYPED_RUNTIME_COMMAND_TYPES.map((type) => {
      const registered = RUNTIME_COMMAND_CONTRACTS[
        type as keyof typeof RUNTIME_COMMAND_CONTRACTS
      ];
      return {
        type,
        readsPayload: registered.request.access !== 'none',
        directPayloadCast: false,
        requestAccess: registered.request.access,
        error: registered.error,
      };
    });
    const liveContracts = typedContracts;
    const live = liveContracts.map((contract) => contract.type);
    const declaredContracts = extractMessageActionContracts(typesSource);
    const declared = declaredContracts.map((contract) => contract.type);
    const shared = live.filter((type) => declared.includes(type));
    const liveOnly = live.filter((type) => !declared.includes(type));
    const declaredOnly = declared.filter((type) => !live.includes(type));
    const registryEntries = Object.entries(RUNTIME_COMMAND_CONTRACTS);
    const registryLive = registryEntries
      .filter(([, contract]) => contract.surface !== 'declared-only')
      .map(([type]) => type);
    const registryDeclared = registryEntries
      .filter(([, contract]) => contract.surface !== 'live-only')
      .map(([type]) => type);

    expectSortedEqual(live, readInventoryList('Live Background Router'));
    expectSortedEqual(declared, readInventoryList('Declared `MessageAction` Union'));
    expectSortedEqual(liveOnly, readInventoryList('Live Router Only'));
    expectSortedEqual(declaredOnly, readInventoryList('Declared Only'));
    expectSortedEqual(registryLive, live);
    expectSortedEqual(registryDeclared, declared);
    expectSortedEqual(typedContracts.map((contract) => contract.type), TYPED_RUNTIME_COMMAND_TYPES);
    expectSortedEqual(declaredOnly, CLIENT_ONLY_RUNTIME_COMMAND_TYPES);
    const groupedLedger = COMMAND_GROUP_SECTIONS.flatMap(([heading, count]) => {
      const commands = readInventoryList(heading, 3);
      expect(commands, heading).toHaveLength(count);
      return commands;
    });
    expect(groupedLedger).toHaveLength(89);
    expect(new Set(groupedLedger).size).toBe(groupedLedger.length);
    expectSortedEqual(groupedLedger, live);
    expect(registryEntries).toHaveLength(91);
    for (const contract of liveContracts) {
      const registered = RUNTIME_COMMAND_CONTRACTS[contract.type as keyof typeof RUNTIME_COMMAND_CONTRACTS];
      expect(registered.owner).toBe(getRuntimeCommandOwner(contract.type));
      expect(registered.request.access).toBe(contract.requestAccess);
      expect(registered.error).toBe(contract.error);
    }
    for (const contract of declaredContracts) {
      const registered = RUNTIME_COMMAND_CONTRACTS[contract.type as keyof typeof RUNTIME_COMMAND_CONTRACTS];
      expect(registered.request.presence).toBe(contract.payloadPresence);
    }
    expect({
      liveCommands: live.length,
      declaredActions: declared.length,
      shared: shared.length,
      liveOnly: liveOnly.length,
      declaredOnly: declaredOnly.length,
      readsPayload: liveContracts.filter((contract) => contract.readsPayload).length,
      ignoresPayload: liveContracts.filter((contract) => !contract.readsPayload).length,
      directPayloadCasts: liveContracts.filter((contract) => contract.directPayloadCast).length,
      decodedPayloads: liveContracts.filter((contract) => (
        contract.requestAccess === 'payload-decoded'
      )).length,
      delegatedPayloads: liveContracts.filter((contract) => (
        contract.requestAccess === 'payload-delegated'
      )).length,
    }).toEqual(RUNTIME_TOPOLOGY);
    expect(new Set(live).size).toBe(live.length);
    expect(new Set(declared).size).toBe(declared.length);
    for (const type of live) expect(getRuntimeCommandOwner(type)).toBeDefined();
  });

  it('keeps the inventory prose counts in sync with the frozen topology', () => {
    // ⚠️⚠️ **这条守的是「文档正文里的数字」** —— 前面几条只校验**列表块**里的命令名，
    // 而正文散文里那些计数（`declares 65 unique` / `Sixty-three names are shared` /
    // `60/30` / `57 decoded`）**没有任何东西在读**。
    // 实测后果：删掉 `APPEND_EXTERNAL_TOOL_PAYLOAD_CHUNK` 之后，列表块全部同步了、
    // 契约测试全绿，而正文里 65 / 63 / 60 / 57 四处仍是旧值 ⇒ 这份自称
    // "name-level authority" 的文档**自相矛盾**，且不会让任何用例变红。
    //
    // 判据：正文里出现的每个计数都必须等于 fixture 里对应字段。
    const numbers = (pattern: RegExp) => matches(inventorySource, pattern);
    const [liveCommands, declaredActions, shared, liveOnly, declaredOnly] = [
      RUNTIME_TOPOLOGY.liveCommands,
      RUNTIME_TOPOLOGY.declaredActions,
      RUNTIME_TOPOLOGY.shared,
      RUNTIME_TOPOLOGY.liveOnly,
      RUNTIME_TOPOLOGY.declaredOnly,
    ];

    // ⚠️ `matches()` 只返回第 1 个捕获组，多组的地方要自己取。
    const groups = (pattern: RegExp): string[][] => [...inventorySource.matchAll(pattern)]
      .map((match) => match.slice(1).map(String));

    expect(numbers(/declares (\d+) unique command names/g).map(Number), 'MessageAction 声明数')
      .toEqual([declaredActions]);
    // ⚠️ 数词在句首大写、句中全小写（`Sixty-two … and two are declared-only`）⇒ 归一成小写再比。
    expect(
      groups(/([\w-]+) names are shared, (\d+) are live-router-only, and ([\w-]+) are declared-only/g)
        .map((row) => row.map((cell) => cell.toLowerCase())),
      '共享 / 仅活路由 / 仅声明 三个计数',
    ).toEqual([[
      ENGLISH_NUMBER_WORDS[shared].toLowerCase(),
      String(liveOnly),
      ENGLISH_NUMBER_WORDS[declaredOnly].toLowerCase(),
    ]]);
    // ⚠️ 数词在句首大写、句中全小写（`Sixty-two … and two are declared-only`）
    // ⇒ 上面那条比较要归一成小写再比。

    expect(groups(/It freezes `89\/(\d+)\/(\d+)\/(\d+)\/(\d+)`/g).map((row) => row.map(Number)),
      '契约测试段：declared / shared / liveOnly / declaredOnly')
      .toEqual([[declaredActions, shared, liveOnly, declaredOnly]]);
    expect(groups(/current `(\d+)\/(\d+)` payload access/g).map((row) => row.map(Number)),
      '契约测试段：readsPayload / ignoresPayload')
      .toEqual([[RUNTIME_TOPOLOGY.readsPayload, RUNTIME_TOPOLOGY.ignoresPayload]]);
    expect(numbers(/(\d+) decoded \/ 0 direct-cast/g).map(Number), '契约测试段：decoded 数')
      .toEqual([RUNTIME_TOPOLOGY.decodedPayloads]);
    expect(groups(/`(\d+) typed \/ 0 legacy \/ (\d+) client-only`/g).map((row) => row.map(Number)),
      '所有者模型段：typed / client-only')
      .toEqual([[liveCommands, declaredOnly]]);
  });

  it('freezes serializable request and response families without creating a second router', () => {
    for (const fixture of RUNTIME_REQUEST_FIXTURES) {
      expect(JSON.parse(JSON.stringify(fixture.message))).toEqual(fixture.message);
    }
    for (const fixture of RUNTIME_RESPONSE_FIXTURES) {
      expect(JSON.parse(JSON.stringify(fixture.response))).toEqual(fixture.response);
    }

    expect(new Set(RUNTIME_REQUEST_FIXTURES.map((fixture) => fixture.family))).toEqual(new Set([
      'none',
      'required',
      'optional',
      'tool-call',
    ]));
    expect(new Set(RUNTIME_RESPONSE_FIXTURES.map((fixture) => fixture.family))).toEqual(new Set([
      'value',
      'nullable-value',
      'ack',
      'status',
      'tool-result',
      'domain-error',
      'status-or-domain-error',
      'status-or-domain-error-or-tool-result',
      'value-or-domain-error',
    ]));
    const responseFixtureFamilies = new Set(RUNTIME_RESPONSE_FIXTURES.map((fixture) => fixture.family));
    for (const contract of Object.values(RUNTIME_COMMAND_CONTRACTS)) {
      if (contract.response !== 'unrouted') expect(responseFixtureFamilies.has(contract.response)).toBe(true);
    }
  });

  it('freezes handler-level error responses independently of localized copy', () => {
    const nonObject = RUNTIME_ERROR_FIXTURES.nonObjectMessage;
    const tool = RUNTIME_ERROR_FIXTURES.toolHandlerRejection;
    const generic = RUNTIME_ERROR_FIXTURES.genericHandlerRejection;

    expect(createBackgroundErrorResponse(nonObject.message, nonObject.error, 'Tool execution failed'))
      .toEqual(nonObject.response);
    expect(createBackgroundErrorResponse(tool.message, new Error(tool.error), tool.response.summary))
      .toEqual(tool.response);
    expect(createBackgroundErrorResponse(generic.message, new Error(generic.error), 'unused'))
      .toEqual(generic.response);
  });

  it('closes the payload-decoding and legacy-router gaps', () => {
    expect(RUNTIME_CURRENT_GAPS).toEqual([]);
    expect(backgroundSource).not.toContain('handleLegacyMessage');
    expect(backgroundSource).not.toContain('handleLegacy:');
    for (const resolved of RUNTIME_RESOLVED_ROUTING_CASES) {
      expect(resolved.target).toBe('rejected-by-command-registry');
      expect(createUnknownRuntimeCommandResponse()).toEqual(resolved.response);
      expect(getRuntimeCommandOwner(resolved.input.type)).toBe(
        resolved.input.type === 'UNKNOWN_COMMAND' ? undefined : 'client-only',
      );
    }
    for (const resolved of RUNTIME_RESOLVED_BOUNDARY_CASES) {
      expect(resolved.target).toBe('rejected-at-message-boundary');
      expect(() => decodeRuntimeMessageEnvelope(resolved.input)).toThrow();
    }
  });

  it('classifies nullable typed responses consistently with their exact contracts', () => {
    expect(RUNTIME_COMMAND_CONTRACTS.GET_BACKGROUND.response).toBe('nullable-value');
  });

  it('freezes all runtime notifications and tab RPC names', () => {
    const broadcastTypes = matches(backgroundSource, /broadcastToTabs\(\{\s*type:\s*'([^']+)'/g);
    const runtimeNotificationTypes = matches(backgroundSource, /chrome\.runtime\.sendMessage\(\{\s*type:\s*'([^']+)'/g);
    const notificationTypes = [...broadcastTypes, ...runtimeNotificationTypes];
    const directTabRpcTypes = matches(
      backgroundSource,
      /chrome\.tabs\.sendMessage\([^,]+,\s*\{\s*type:\s*'([^']+)'/g,
    );
    const refreshAuthType = backgroundSource.match(/const REFRESH_AUTH_MESSAGE = \{ type: '([^']+)' \}/)?.[1];

    expect(new Set(notificationTypes)).toEqual(new Set(RUNTIME_NOTIFICATION_TYPES));
    expect(notificationTypes).toHaveLength(RUNTIME_NOTIFICATION_TYPES.length);
    expect([refreshAuthType, ...directTabRpcTypes]).toEqual([...RUNTIME_TAB_RPC_TYPES]);
  });
});

interface RuntimeCaseContract {
  type: string;
  readsPayload: boolean;
  directPayloadCast: boolean;
  requestAccess: RuntimeRequestBoundary;
  error: RuntimeErrorFamily;
}

interface MessageActionContract {
  type: string;
  payloadPresence: RuntimePayloadPresence;
}

function extractMessageActionContracts(source: string): MessageActionContract[] {
  const actionAlias = findTypeAliasDeclaration(
    parseTypeScriptSource('types.ts', source),
    'MessageAction',
  );
  if (!actionAlias || !t.isTSUnionType(actionAlias.typeAnnotation)) {
    throw new Error('MessageAction union not found');
  }

  return actionAlias.typeAnnotation.types.map((member) => {
    if (!t.isTSTypeLiteral(member)) throw new Error('MessageAction member is not a type literal');
    const typeProperty = member.members.find((candidate): candidate is t.TSPropertySignature =>
      isNamedTypeProperty(candidate, 'type'),
    );
    const literal = typeProperty?.typeAnnotation?.typeAnnotation;
    if (!literal || !t.isTSLiteralType(literal) || !t.isStringLiteral(literal.literal)) {
      throw new Error('MessageAction member has no string-literal type');
    }
    const payloadProperty = member.members.find((candidate): candidate is t.TSPropertySignature =>
      isNamedTypeProperty(candidate, 'payload'),
    );
    return {
      type: literal.literal.value,
      payloadPresence: payloadProperty ? payloadProperty.optional ? 'optional' : 'required' : 'none',
    };
  });
}

function isNamedTypeProperty(
  candidate: t.TSTypeElement,
  name: string,
): candidate is t.TSPropertySignature {
  return t.isTSPropertySignature(candidate)
    && !candidate.computed
    && (
      t.isIdentifier(candidate.key, { name })
      || t.isStringLiteral(candidate.key, { value: name })
    );
}

function readInventoryList(heading: string, level = 2): string[] {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fence = '`'.repeat(3);
  const block = inventorySource.match(
    new RegExp(`${'#'.repeat(level)} ${escapedHeading}[^\\n]*\\n\\n${fence}text\\n([\\s\\S]*?)\\n${fence}`),
  )?.[1];
  if (!block) throw new Error(`Inventory block not found: ${heading}`);
  return block.split('\n').filter(Boolean);
}

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function expectSortedEqual(actual: readonly string[], expected: readonly string[]): void {
  expect([...actual].sort()).toEqual([...expected].sort());
}
