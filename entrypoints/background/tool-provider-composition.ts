import {
  deleteMemory,
  getMemoryById,
  saveMemory,
  updateMemory,
} from '../../core/memory/store';
import {
  executeMcpToolCall,
  getMcpToolDescriptors,
  refreshMcpServerDiscovery,
} from '../../core/mcp/discovery';
import { getAllMcpServers } from '../../core/mcp/store';
import type { Memory, NewMemory } from '../../core/types';
import {
  SKILL_CREATOR_TOOL_PROVIDER,
  createSkillCreatorToolDescriptors,
  executeSkillCreatorToolCall,
} from '../../core/skill/creator-tool';
import {
  MEMORY_IMPORT_TOOL_PROVIDER,
  createMemoryImportToolDescriptors,
  executeMemoryImportToolCall,
} from '../../core/memory/import-tool';
import {
  BROWSER_CONTROL_PROVIDER,
  createBrowserControlToolDescriptors,
  executeBrowserControlToolCall,
  shouldExposeBrowserControlTools,
} from '../../core/browser-control/tool';
import {
  createMemoryToolDescriptors,
  executeMemoryToolCall,
  MEMORY_TOOL_PROVIDER,
  type MemoryToolRuntime,
} from '../../core/tool/memory';
import {
  MCP_CAPABILITY_TOOL_PROVIDER,
  createMcpCapabilityToolDescriptors,
  disambiguateMcpCapabilityToolDescriptors,
  executeMcpCapabilityToolCall,
} from '../../core/mcp/capability-tools';
import {
  ToolProviderRegistry,
  type RuntimeToolProvider,
  type ToolProviderDescriptorContext,
  type ToolProviderExecutionContext,
} from '../../core/tool/provider-registry';
import type { ToolCall, ToolDescriptor, ToolResult } from '../../core/tool/types';

const memoryRuntime: MemoryToolRuntime = {
  async saveMemory(input: NewMemory) {
    const id = await saveMemory(input);
    return { id };
  },
  async getMemoryById(id: number) {
    return (await getMemoryById(id)) ?? null;
  },
  async updateMemory(memory: Memory) {
    await updateMemory(memory);
  },
  async deleteMemory(id: number) {
    await deleteMemory(id);
  },
};

export function createProductionToolProviderRegistry(): ToolProviderRegistry {
  return new ToolProviderRegistry([
    createLocalProvider(
      MEMORY_TOOL_PROVIDER.id,
      ({ locale }) => createMemoryToolDescriptors(locale),
      (call, _descriptor, { locale }) => executeMemoryToolCall(memoryRuntime, call, locale),
    ),
    createLocalProvider(
      SKILL_CREATOR_TOOL_PROVIDER.id,
      ({ locale }) => createSkillCreatorToolDescriptors(locale),
      (call, _descriptor, { locale }) => executeSkillCreatorToolCall(call, locale),
    ),
    createLocalProvider(
      MEMORY_IMPORT_TOOL_PROVIDER.id,
      ({ locale }) => createMemoryImportToolDescriptors(locale),
      (call, _descriptor, { locale }) => executeMemoryImportToolCall(call, locale),
    ),
    createLocalProvider(
      BROWSER_CONTROL_PROVIDER.id,
      async ({ locale }) => {
        if (!await shouldExposeBrowserControlTools()) return [];
        return createBrowserControlToolDescriptors(locale);
      },
      // ⚠️ **`signal` 必须往下传** —— 它是 `execution.timeoutMs` 唯一的落地路径
      // （`executeRuntimeToolCall` 建 scope → provider context → 这里 → cdp.sendCommand）。
      (call, _descriptor, { locale, signal }) => executeBrowserControlToolCall(call, locale, signal),
    ),
    createMcpCapabilityProvider(),
    createMcpProvider(),
  ]);
}

function createLocalProvider(
  id: string,
  listTools: (context: ToolProviderDescriptorContext) => ToolDescriptor[] | Promise<ToolDescriptor[]>,
  execute: (
    call: ToolCall,
    authorizedDescriptor: ToolDescriptor,
    context: ToolProviderExecutionContext,
  ) => Promise<ToolResult>,
): RuntimeToolProvider {
  return {
    registration: { kind: 'local', id },
    async listTools(context) {
      return listTools(context);
    },
    execute,
  };
}

function createMcpProvider(): RuntimeToolProvider {
  return {
    registration: { kind: 'mcp' },
    async listTools({ includeDisabled }) {
      return disambiguateMcpInvocationNames(
        await getMcpToolDescriptors(includeDisabled ? { includeDisabled: true } : undefined),
      );
    },
    async refresh() {
      const servers = await getAllMcpServers({ includeSecrets: false });
      await Promise.all(
        servers
          .filter((server) => server.enabled)
          .map((server) => refreshMcpServerDiscovery(server.id)),
      );
    },
    execute(call, authorizedDescriptor, options) {
      return executeMcpToolCall(call, authorizedDescriptor, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        maxResultBytes: options.maxResultBytes,
      });
    },
  };
}

/**
 * MCP invocation names are derived from sanitized server/tool identifiers, so
 * distinct servers can collide (e.g. `my-server` vs `my_server`). The registry
 * treats duplicate invocation names as fatal and would disable the whole tool
 * registry (M18); disambiguate the later duplicates deterministically instead.
 *
 * ⚠️ **Every allocated name has to be fed back into the occupied set.** A server can
 * publish `read-file`, `read_file` *and* `read_file_2`: renaming the second one to
 * `…_read_file_2` without recording it makes it collide with the third, and the registry
 * then throws `tool_invocation_duplicate` — which disables every tool, not just these
 * three. Collect the original names first, then allocate with a loop that skips taken
 * names (same shape as `allocateCapabilityInvocationName`).
 */
export function disambiguateMcpInvocationNames(
  descriptors: readonly ToolDescriptor[],
): ToolDescriptor[] {
  if (!Array.isArray(descriptors)) return descriptors as ToolDescriptor[];
  const occupied = new Set<string>();
  const firstIndexByBase = new Map<string, number>();
  descriptors.forEach((descriptor, index) => {
    if (!firstIndexByBase.has(descriptor.invocationName)) {
      firstIndexByBase.set(descriptor.invocationName, index);
    }
  });
  // Reserve every name that survives unchanged before allocating replacements, so a
  // generated suffix can never land on a later descriptor's original name.
  descriptors.forEach((descriptor, index) => {
    if (firstIndexByBase.get(descriptor.invocationName) === index) {
      occupied.add(descriptor.invocationName);
    }
  });
  return descriptors.map((descriptor, index) => {
    if (firstIndexByBase.get(descriptor.invocationName) === index) return descriptor;
    let suffix = 2;
    let candidate = `${descriptor.invocationName}_${suffix}`;
    while (occupied.has(candidate)) {
      suffix += 1;
      candidate = `${descriptor.invocationName}_${suffix}`;
    }
    occupied.add(candidate);
    return { ...descriptor, invocationName: candidate };
  });
}

function createMcpCapabilityProvider(): RuntimeToolProvider {
  return {
    ...createLocalProvider(
      MCP_CAPABILITY_TOOL_PROVIDER.id,
      ({ locale }) => createMcpCapabilityToolDescriptors(locale),
      executeMcpCapabilityToolCall,
    ),
    disambiguateInvocationNames: disambiguateMcpCapabilityToolDescriptors,
  };
}
