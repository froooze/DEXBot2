/**
 * tests/test_node_connect_policy.ts — pure post-connect node-quality policy.
 *
 * Covers Gap 4 from the node-failover review: after the transport reports a
 * connection the client must (a) switch away from a blacklisted active node
 * when healthy alternatives exist and (b) otherwise keep the transport's
 * candidate list aligned with the healthy set. The decision was extracted to
 * modules/node_connect_policy.ts so it can be tested without the full client.
 */

const assert = require('assert');
const { resolveConnectedNodeAction } = require('../modules/node_connect_policy');

const BASE = {
    healthCheckEnabled: true,
    reconnectInProgress: false,
    activeNode: 'wss://good.test/ws',
    isBlacklisted: () => false,
    getHealthyNodes: () => ['wss://good.test/ws', 'wss://alt.test/ws'],
};

async function testCNP001_HealthyActiveAligns() {
    console.log('\n[CNP-001] Healthy active node aligns the candidate list...');
    const r = resolveConnectedNodeAction(BASE);
    assert.deepStrictEqual(r, { action: 'align', nodes: BASE.getHealthyNodes() });
    console.log('✓ CNP-001 passed');
}

async function testCNP002_BlacklistedActiveSwitches() {
    console.log('\n[CNP-002] Blacklisted active node switches to healthy alternatives...');
    let isBlacklistedCalls = 0;
    const r = resolveConnectedNodeAction({
        ...BASE,
        activeNode: 'wss://stale.test/ws',
        isBlacklisted: (url: string) => { isBlacklistedCalls++; return url === 'wss://stale.test/ws'; },
    });
    assert.strictEqual(r.action, 'switch', 'must switch away');
    assert.deepStrictEqual(r.nodes, ['wss://good.test/ws', 'wss://alt.test/ws']);
    assert.strictEqual(r.reason, 'connected-on-blacklisted-node');
    assert.strictEqual(isBlacklistedCalls, 1, 'blacklist checked exactly once');
    console.log('✓ CNP-002 passed');
}

async function testCNP003_BlacklistedNoAlternativeStays() {
    console.log('\n[CNP-003] Blacklisted active node with no alternative stays put...');
    const r = resolveConnectedNodeAction({
        ...BASE,
        activeNode: 'wss://stale.test/ws',
        isBlacklisted: () => true,
        getHealthyNodes: () => [],
    });
    assert.deepStrictEqual(r, { action: 'none' }, 'never disconnect from the only reachable node');
    console.log('✓ CNP-003 passed');
}

async function testCNP004_NoHealthySetNoAlign() {
    console.log('\n[CNP-004] Empty healthy set produces no align action...');
    const r = resolveConnectedNodeAction({ ...BASE, getHealthyNodes: () => [] });
    assert.deepStrictEqual(r, { action: 'none' });
    console.log('✓ CNP-004 passed');
}

async function testCNP005_ReconnectInProgressSuppresses() {
    console.log('\n[CNP-005] An in-progress reconnect suppresses all actions...');
    let blacklistChecked = false;
    const r = resolveConnectedNodeAction({
        ...BASE,
        reconnectInProgress: true,
        activeNode: 'wss://stale.test/ws',
        isBlacklisted: () => { blacklistChecked = true; return true; },
    });
    assert.deepStrictEqual(r, { action: 'none' });
    assert.strictEqual(blacklistChecked, false, 'no work when a reconnect is already running');
    console.log('✓ CNP-005 passed');
}

async function testCNP006_HealthCheckDisabledSuppresses() {
    console.log('\n[CNP-006] Disabled health checks suppress all actions...');
    const r = resolveConnectedNodeAction({
        ...BASE,
        healthCheckEnabled: false,
        activeNode: 'wss://stale.test/ws',
        isBlacklisted: () => true,
    });
    assert.deepStrictEqual(r, { action: 'none' });
    console.log('✓ CNP-006 passed');
}

async function testCNP007_UnknownActiveAligns() {
    console.log('\n[CNP-007] Unknown active node still aligns the candidate list...');
    const r = resolveConnectedNodeAction({ ...BASE, activeNode: null });
    assert.strictEqual(r.action, 'align');
    console.log('✓ CNP-007 passed');
}

async function testCNP008_AlignKeepsActiveNodeLast() {
    console.log('\n[CNP-008] Align keeps the connected node in the candidate list (appended last)...');
    const healthy = ['wss://alt.test/ws', 'wss://third.test/ws'];
    const activeNode = 'wss://active.test/ws';
    const r = resolveConnectedNodeAction({
        ...BASE,
        activeNode,
        getHealthyNodes: () => healthy,
    });
    assert.strictEqual(r.action, 'align');
    assert.deepStrictEqual(
        r.nodes,
        [...healthy, activeNode],
        'active node must survive setNodes(), otherwise the transport tears down a healthy socket'
    );
    assert.deepStrictEqual(healthy, ['wss://alt.test/ws', 'wss://third.test/ws'], 'input list must not be mutated');
    console.log('✓ CNP-008 passed');
}

async function testCNP009_AlignDoesNotDuplicateActiveNode() {
    console.log('\n[CNP-009] Align never duplicates an already-listed active node...');
    const r = resolveConnectedNodeAction({ ...BASE, activeNode: 'wss://alt.test/ws' });
    assert.deepStrictEqual(r, {
        action: 'align',
        nodes: ['wss://good.test/ws', 'wss://alt.test/ws'],
    });
    console.log('✓ CNP-009 passed');
}

async function runAllTests() {
    console.log('=== Node Connect Policy Test Suite ===\n');
    await testCNP001_HealthyActiveAligns();
    await testCNP002_BlacklistedActiveSwitches();
    await testCNP003_BlacklistedNoAlternativeStays();
    await testCNP004_NoHealthySetNoAlign();
    await testCNP005_ReconnectInProgressSuppresses();
    await testCNP006_HealthCheckDisabledSuppresses();
    await testCNP007_UnknownActiveAligns();
    await testCNP008_AlignKeepsActiveNodeLast();
    await testCNP009_AlignDoesNotDuplicateActiveNode();
    console.log('\n=== All node-connect-policy tests passed! ===');
}

runAllTests().catch((e: any) => { console.error(e); process.exit(1); });
