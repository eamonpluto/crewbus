// CrewBus M5 Approvals screen — interactive decision cards with reason gating. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { useStyles } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { IconApprovals, IconCheck, IconClose } from '../components/Icons.jsx';
import { ROUTES } from '../navigation/routes.js';
import { startWatch, buzz } from '../lib/watch.js';

function ApprovalCard({ T, S, styles, item, onDecide }) {
  const [reason, setReason] = React.useState('');
  const id = item.id || item.replyId;
  return (
    <View style={[S.card, styles.cardGap]}>
      <View style={S.row}>
        <View style={styles.badgeWrap}>
          <IconApprovals size={12} color={T.amber} />
          <Text style={styles.badge}>APPROVAL</Text>
        </View>
        <Text style={styles.sender}>@{item.from || 'worker'}</Text>
      </View>
      <Text style={S.cardTitle}>{item.subject || '(no subject)'}</Text>
      <View style={styles.bodyBox}><Text style={styles.bodyText} numberOfLines={4}>{item.body || item.detail || ''}</Text></View>
      <TextInput style={S.input} value={reason} onChangeText={setReason} placeholder="Reason (required to deny)" placeholderTextColor={T.textSubtle} />
      <View style={S.row}>
        <TouchableOpacity style={[S.btnSuccess, styles.btnInner, { flex: 1 }]} onPress={() => onDecide(id, 'approve', reason)}>
          <IconCheck size={14} color={T.emerald} />
          <Text style={[S.btnText, { color: T.emerald }]}>Approve</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[S.btnDanger, styles.btnInner, { flex: 1 }]} onPress={() => onDecide(id, 'deny', reason)}>
          <IconClose size={14} color={T.rose} />
          <Text style={[S.btnText, { color: T.rose }]}>Deny</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}


export function ApprovalsScreen({ ctx, navigation }) {
  const { T, S } = useStyles();
  const styles = React.useMemo(() => StyleSheet.create({
  cardGap: { padding: 14, gap: 10, marginVertical: 6 },
  badgeWrap: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: T.amberMuted, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  badge: { color: T.amber, fontSize: 11, fontWeight: '700' },
  sender: { color: T.primaryLight, fontSize: 12, fontWeight: '600' },
  bodyBox: { backgroundColor: T.cardElevated, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: T.border },
  bodyText: { color: T.text, fontSize: 12, fontFamily: 'monospace' },
  btnInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  }), [T]);
  const [agent] = React.useState('mobile');
  const [agentToken] = React.useState('');
  const [items, setItems] = React.useState([]);
  const [alert, setAlert] = React.useState(null);
  const [status, setStatus] = React.useState('Ready to sync approvals.');

  const currentApi = () => {
    const route = ctx.connection.getState().route;
    if (!route) throw new Error('no route connected — connect in Hub');
    return ctx.apiFor(route);
  };
  // Foreground watch while mounted (see TriageScreen): new approvals buzz
  // even when the user isn't pulling-to-refresh inside the 300s window.
  React.useEffect(() => {
    const stop = startWatch({ getApi: () => currentApi(), agent: agent.trim() || 'mobile', onAlert: (a) => { buzz(); setAlert(a); } });
    return stop;
  }, [agent]);

  const load = async () => {
    const target = agent.trim() || 'mobile';
    try {
      const data = await currentApi().fetchInbox(target, { unacked: 1, limit: 50 });
      const list = Array.isArray(data) ? data : data.items || data.messages || [];
      const approvals = list.filter((m) => /^approval:\s*/i.test(String(m.subject || '')) || m.request);
      setItems(approvals.length ? approvals : list);
      setStatus(`${approvals.length} pending decision${approvals.length === 1 ? '' : 's'}`);
    } catch (e) { setStatus(`offline: ${String((e && e.message) || e)}`); }
  };

  const decide = async (id, decision, reason) => {
    if (decision === 'deny' && !reason.trim()) { setStatus('A reason is required to deny.'); return; }
    const target = agent.trim() || 'mobile';
    try {
      await currentApi().approve({ from: target, agentToken, id, decision, reason });
      setItems((prev) => prev.filter((m) => (m.id || m.replyId) !== id));
      setStatus(`${decision}d ${id}`);
    } catch {
      ctx.cache.enqueue({ kind: 'approve', from: target, agentToken, id, decision, reason });
      setStatus('offline — decision queued for Queue retry');
    }
  };

  return (
    <View style={S.screen}>
      <HeaderBar title="Approvals" statusText={status} navigation={navigation} rightTitle="Check" onRightPress={load} />
      <View style={S.body}>
        {alert ? (
          <View style={S.alertBox}>
            <Text style={S.alertTitle}>{alert.title}</Text>
            <Text style={S.cardSub} numberOfLines={2}>{alert.body}</Text>
            <TouchableOpacity onPress={() => setAlert(null)}><Text style={S.dismiss}>Dismiss</Text></TouchableOpacity>
          </View>
        ) : null}
        <FlatList
          data={items}
          keyExtractor={(m, i) => String(m.id || m.replyId || i)}
          ListEmptyComponent={<Text style={S.empty}>No pending approvals. All workers unblocked!</Text>}
          renderItem={({ item }) => <ApprovalCard T={T} S={S} styles={styles} item={item} onDecide={decide} />}
        />
      </View>
      <BottomNav currentRoute={ROUTES.Approvals} navigation={navigation} badgeApprovals={items.length} />
    </View>
  );
}

