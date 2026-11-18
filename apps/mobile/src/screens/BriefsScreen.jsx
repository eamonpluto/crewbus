// CrewBus M5 Briefs / Missions screen — conversation stream & execution thread.
// Displays user prompts, agent checkpoints, final reports, and interactive inline approvals.
import React from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useStyles } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { IconApprovals, IconCheck, IconClose, IconLaunch, IconPlus } from '../components/Icons.jsx';
import { ROUTES } from '../navigation/routes.js';

function timeAgo(iso) {
  if (!iso) return '';
  try {
    const t = Date.parse(iso);
    if (isNaN(t)) return '';
    const diff = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (diff < 60) return `${diff}s ago`;
    const m = Math.floor(diff / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  } catch {
    return '';
  }
}

export function BriefsScreen({ ctx, navigation }) {
  const { T, S } = useStyles();

  const styles = React.useMemo(
    () =>
      StyleSheet.create({
        rail: {
          paddingHorizontal: 14,
          paddingVertical: 8,
          gap: 8,
          borderBottomWidth: 1,
          borderBottomColor: T.border,
          backgroundColor: T.cardElevated,
        },
        missionChip: {
          backgroundColor: T.card,
          borderWidth: 1,
          borderColor: T.border,
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 7,
          marginRight: 8,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        },
        missionChipSel: {
          borderColor: T.primary,
          backgroundColor: T.primaryMuted,
        },
        missionChipText: {
          color: T.textMuted,
          fontSize: 12,
          fontWeight: '600',
        },
        missionChipTextSel: {
          color: T.text,
          fontWeight: '700',
        },
        dot: {
          width: 7,
          height: 7,
          borderRadius: 4,
        },
        streamScroll: {
          flex: 1,
          padding: 14,
        },
        msgHeader: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 4,
        },
        authorText: {
          color: T.primaryLight,
          fontSize: 12,
          fontWeight: '700',
        },
        timeText: {
          color: T.textSubtle,
          fontSize: 11,
        },
        tagRow: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 6,
          marginTop: 6,
        },
        tag: {
          backgroundColor: T.softFill,
          borderWidth: 1,
          borderColor: T.border,
          borderRadius: 4,
          paddingHorizontal: 6,
          paddingVertical: 2,
        },
        tagText: {
          color: T.textSubtle,
          fontSize: 10,
          fontWeight: '600',
        },
        approvalCard: {
          borderWidth: 1,
          borderColor: T.amber,
          backgroundColor: T.amberMuted,
          borderRadius: 8,
          padding: 12,
          marginVertical: 6,
          gap: 8,
        },
        approvalHead: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        },
        approvalTitle: {
          color: T.amber,
          fontSize: 12,
          fontWeight: '700',
        },
        cmdBox: {
          backgroundColor: T.cardElevated,
          borderWidth: 1,
          borderColor: T.border,
          borderRadius: 6,
          padding: 8,
        },
        cmdText: {
          fontFamily: 'monospace',
          fontSize: 12,
          color: T.text,
        },
        actionRow: {
          flexDirection: 'row',
          gap: 8,
          marginTop: 2,
        },
        emptyHero: {
          padding: 24,
          alignItems: 'center',
          gap: 12,
          marginTop: 20,
        },
        heroTitle: {
          color: T.text,
          fontSize: 18,
          fontWeight: '800',
          textAlign: 'center',
        },
        heroSub: {
          color: T.textMuted,
          fontSize: 13,
          lineHeight: 19,
          textAlign: 'center',
          maxWidth: 320,
        },
        suggestionCard: {
          width: '100%',
          backgroundColor: T.card,
          borderWidth: 1,
          borderColor: T.border,
          borderRadius: 8,
          padding: 12,
          gap: 4,
          marginVertical: 4,
        },
        suggestionTitle: {
          color: T.text,
          fontSize: 13,
          fontWeight: '700',
        },
        suggestionSub: {
          color: T.textSubtle,
          fontSize: 11,
        },
      }),
    [T],
  );

  const [briefs, setBriefs] = React.useState([]);
  const [activeBatch, setActiveBatch] = React.useState(null);
  const [threadItems, setThreadItems] = React.useState([]);
  const [approvals, setApprovals] = React.useState([]);
  const [reasons, setReasons] = React.useState({});
  const [loading, setLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState('Connecting to mission board…');

  const currentApi = () =>
    ctx.getApi ? ctx.getApi() : ctx.apiFor(ctx.connection.getState().route);

  const loadBoard = async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const api = currentApi();
      const board = await api.fetchBoard();
      const list = Array.isArray(board.briefs) ? board.briefs : [];
      setBriefs(list);

      // Fetch pending approvals for inline decision cards
      let pendingList = [];
      try {
        const inbox = await api.fetchInbox('mobile', { unacked: 1, limit: 30 });
        const msgs = Array.isArray(inbox) ? inbox : inbox.items || inbox.messages || [];
        pendingList = msgs.filter(
          (m) => /^approval:\s*/i.test(String(m.subject || '')) || m.request,
        );
        setApprovals(pendingList);
      } catch {
        // Approvals inbox optional in disconnected mode
      }

      setStatus(`${list.length} mission${list.length === 1 ? '' : 's'}`);

      // Auto-select latest mission if none selected or current is stale
      if (list.length > 0) {
        const cur = activeBatch && list.some((b) => b.batch === activeBatch) ? activeBatch : list[0].batch;
        if (cur !== activeBatch) {
          selectMission(cur);
        } else {
          loadThread(cur);
        }
      } else {
        setActiveBatch(null);
        setThreadItems([]);
      }
    } catch {
      setStatus('offline — check relay');
    } finally {
      if (isManual) setRefreshing(false);
    }
  };

  const loadThread = async (batch) => {
    if (!batch) return;
    try {
      const g = await currentApi().fetchGather(batch);
      const items = Array.isArray(g.items) ? g.items : [];
      setThreadItems(items);
    } catch {
      // offline thread
    }
  };

  const selectMission = (batch) => {
    setActiveBatch(batch);
    setLoading(true);
    loadThread(batch).finally(() => setLoading(false));
  };

  React.useEffect(() => {
    loadBoard().catch(() => null);
  }, []);

  const handleDecide = async (id, decision) => {
    const reason = reasons[id] || '';
    if (decision === 'deny' && !reason.trim()) {
      setStatus('A reason is required to decline.');
      return;
    }
    try {
      await currentApi().approve({
        from: 'mobile',
        agentToken: '',
        id,
        decision,
        reason,
      });
      setApprovals((prev) => prev.filter((a) => (a.id || a.replyId) !== id));
      setStatus(`${decision}d permission`);
    } catch {
      ctx.cache.enqueue({
        kind: 'approve',
        from: 'mobile',
        agentToken: '',
        id,
        decision,
        reason,
      });
      setStatus('offline — decision queued');
    }
  };

  const currentBrief = briefs.find((b) => b.batch === activeBatch);

  // Filter inline approvals relevant to this active mission
  const activeApprovals = React.useMemo(() => {
    if (!approvals.length) return [];
    if (!threadItems.length) return approvals;
    return approvals.filter((ap) =>
      threadItems.some((it) => it.from === ap.from || it.to === ap.from),
    );
  }, [approvals, threadItems]);

  const handleSuggestion = (promptText) => {
    if (navigation) {
      navigation.navigate(ROUTES.Launch, { initialPrompt: promptText });
    }
  };

  return (
    <View style={S.screen}>
      <HeaderBar
        title="Missions"
        statusText={status}
        navigation={navigation}
        rightTitle="+ New"
        onRightPress={() => navigation.navigate(ROUTES.Launch)}
      />

      {/* Horizontal Mission Selector Rail */}
      {briefs.length > 0 ? (
        <View style={styles.rail}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {briefs.map((b) => {
              const isSel = b.batch === activeBatch;
              const hasRunning = (b.workers || []).length > (b.finalCount || 0);
              const label = b.subject
                ? b.subject.replace(/^brief:[ \t]*/, '')
                : `Mission ${String(b.batch).slice(0, 8)}`;
              return (
                <TouchableOpacity
                  key={String(b.batch)}
                  style={[styles.missionChip, isSel && styles.missionChipSel]}
                  onPress={() => selectMission(b.batch)}
                >
                  <View
                    style={[
                      styles.dot,
                      { backgroundColor: hasRunning ? T.emerald : T.textSubtle },
                    ]}
                  />
                  <Text
                    style={[styles.missionChipText, isSel && styles.missionChipTextSel]}
                    numberOfLines={1}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      <ScrollView
        style={styles.streamScroll}
        contentContainerStyle={{ paddingBottom: 28, gap: 10 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadBoard(true)}
            tintColor={T.primary}
          />
        }
      >
        {briefs.length === 0 ? (
          <View style={styles.emptyHero}>
            <IconLaunch size={32} color={T.primary} />
            <Text style={styles.heroTitle}>What should your crew build?</Text>
            <Text style={styles.heroSub}>
              Launch a coordinated crew of AI coding agents. Track their progress, inspect changes,
              and approve sensitive operations directly in this stream.
            </Text>

            <TouchableOpacity
              style={styles.suggestionCard}
              onPress={() => handleSuggestion('Run test suite and fix failing tests')}
            >
              <Text style={styles.suggestionTitle}>Run test suite &amp; fix bugs</Text>
              <Text style={styles.suggestionSub}>Run tests, detect regressions, and patch code</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.suggestionCard}
              onPress={() => handleSuggestion('Refactor module to clean architecture')}
            >
              <Text style={styles.suggestionTitle}>Refactor code</Text>
              <Text style={styles.suggestionSub}>Improve performance and maintainability</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[S.btnPrimary, { width: '100%', marginTop: 8 }]}
              onPress={() => navigation.navigate(ROUTES.Launch)}
            >
              <Text style={S.btnPrimaryText}>+ Launch New Mission</Text>
            </TouchableOpacity>
          </View>
        ) : loading ? (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <ActivityIndicator size="small" color={T.primary} />
          </View>
        ) : (
          <>
            {/* Mission User Prompt Card */}
            {currentBrief ? (
              <View style={S.bubbleUser || S.card}>
                <View style={styles.msgHeader}>
                  <Text style={[styles.authorText, { color: T.text }]}>Mission Brief</Text>
                  <Text style={styles.timeText}>{timeAgo(currentBrief.lastAt)}</Text>
                </View>
                <Text style={S.cardTitle}>{currentBrief.subject || '(no subject)'}</Text>
                <View style={styles.tagRow}>
                  <View style={styles.tag}>
                    <Text style={styles.tagText}>
                      → {(currentBrief.workers || []).join(', ') || 'workers'}
                    </Text>
                  </View>
                  <View style={styles.tag}>
                    <Text style={styles.tagText}>
                      batch {String(currentBrief.batch).slice(0, 8)}
                    </Text>
                  </View>
                  <View style={styles.tag}>
                    <Text style={styles.tagText}>
                      {currentBrief.checkpointCount || 0} checkpoints
                    </Text>
                  </View>
                </View>
              </View>
            ) : null}

            {/* Conversation Stream Items: Checkpoints & Final Reports */}
            {threadItems.map((m) => {
              const isCkpt = m.checkpoint === true;
              return (
                <View key={String(m.id || m.replyId)} style={S.bubbleAgent || S.card}>
                  <View style={styles.msgHeader}>
                    <Text style={styles.authorText}>@{m.from || 'agent'}</Text>
                    <Text style={styles.timeText}>
                      {isCkpt ? 'Checkpoint' : 'Final Report'} · {timeAgo(m.at)}
                    </Text>
                  </View>
                  {m.subject ? (
                    <Text style={[S.cardTitle, { marginBottom: 4 }]}>{m.subject}</Text>
                  ) : null}
                  <Text style={S.cardSub}>{m.body || m.digest || ''}</Text>
                  {m.artifact ? (
                    <View style={[styles.cmdBox, { marginTop: 6 }]}>
                      <Text style={styles.cmdText}>Artifact: {m.artifact}</Text>
                    </View>
                  ) : null}
                </View>
              );
            })}

            {/* Inline Interactive Approvals */}
            {activeApprovals.map((ap) => {
              const id = ap.id || ap.replyId;
              const reasonVal = reasons[id] || '';
              const cmdStr = String(ap.subject || '').replace(/^approval:[ \t]*/i, '');
              return (
                <View key={String(id)} style={styles.approvalCard}>
                  <View style={styles.approvalHead}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <IconApprovals size={14} color={T.amber} />
                      <Text style={styles.approvalTitle}>Permission Request</Text>
                    </View>
                    <Text style={styles.timeText}>{timeAgo(ap.at)}</Text>
                  </View>

                  <Text style={[S.text, { fontWeight: '600' }]}>
                    @{ap.from || 'worker'} requires your approval:
                  </Text>

                  {cmdStr ? (
                    <View style={styles.cmdBox}>
                      <Text style={styles.cmdText}>{cmdStr}</Text>
                    </View>
                  ) : null}

                  {ap.body ? <Text style={S.cardSub}>{ap.body}</Text> : null}

                  <TextInput
                    style={[S.input, { backgroundColor: T.card }]}
                    value={reasonVal}
                    onChangeText={(txt) => setReasons((prev) => ({ ...prev, [id]: txt }))}
                    placeholder="Optional feedback / reason (required to decline)…"
                    placeholderTextColor={T.textSubtle}
                  />

                  <View style={styles.actionRow}>
                    <TouchableOpacity
                      style={[S.btnSuccess, { flex: 1, flexDirection: 'row', gap: 6 }]}
                      onPress={() => handleDecide(id, 'approve')}
                    >
                      <IconCheck size={14} color={T.emerald} />
                      <Text style={[S.btnText, { color: T.emerald }]}>Approve</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[S.btnDanger, { flex: 1, flexDirection: 'row', gap: 6 }]}
                      onPress={() => handleDecide(id, 'deny')}
                    >
                      <IconClose size={14} color={T.rose} />
                      <Text style={[S.btnText, { color: T.rose }]}>Decline</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </>
        )}
      </ScrollView>

      <BottomNav
        currentRoute={ROUTES.Briefs}
        navigation={navigation}
        badgeApprovals={approvals.length}
      />
    </View>
  );
}
