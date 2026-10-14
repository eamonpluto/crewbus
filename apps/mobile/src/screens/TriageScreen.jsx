// CrewBus M5 Triage screen — unacked inbox grouped by brief, 1-tap ack. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { useStyles } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { IconCheck } from '../components/Icons.jsx';
import { ROUTES } from '../navigation/routes.js';
import { startWatch, buzz } from '../lib/watch.js';
const kindOf = (m) => (!m.replyTo ? 'note' : (m.checkpoint === true ? 'checkpoint' : 'final'));

export function TriageScreen({ ctx, navigation }) {
  const { T, S } = useStyles();
  const styles = React.useMemo(() => StyleSheet.create({
  msgCard: { padding: 12, gap: 6, marginVertical: 4 },
  msgHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  senderPill: { backgroundColor: T.primaryMuted, color: T.primaryLight, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, fontSize: 11, fontWeight: '700' },
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 4 },
  ackBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  briefHead: { color: T.text, fontSize: 12, fontWeight: '700', marginTop: 10, marginBottom: 2 },
  }), [T]);
  const [agent, setAgent] = React.useState('mobile');
  const [agentToken, setAgentToken] = React.useState('');
  const [items, setItems] = React.useState([]);
  const [alert, setAlert] = React.useState(null);
  const [status, setStatus] = React.useState('Ready to sync inbox.');

  const currentApi = () => {
    const route = ctx.connection.getState().route;
    if (!route) throw new Error('no route connected — connect in Hub');
    return ctx.apiFor(route);
  };
  // Foreground watch while mounted (no push plugins per scaffold rule): approvals + dead workers alert + buzz.
  React.useEffect(() => {
    return startWatch({ getApi: () => currentApi(), agent: agent.trim() || 'mobile', onAlert: (a) => { buzz(); setAlert(a); } });
  }, [agent]);

  const load = async () => {
    const target = agent.trim() || 'mobile';
    try {
      const data = await currentApi().fetchInbox(target, { unacked: 1, limit: 50 });
      const list = Array.isArray(data) ? data : data.items || data.messages || [];
      ctx.cache.setInbox(target, list);
      setItems(list);
      setStatus(`${list.length} unacked message${list.length === 1 ? '' : 's'}`);
    } catch {
      const cached = ctx.cache.getInbox(target) || [];
      setItems(cached);
      setStatus(`offline (${cached.length} cached)`);
    }
  };

  const ack = async (id) => {
    const target = agent.trim() || 'mobile';
    try {
      await currentApi().ack({ from: target, agentToken, id });
      setItems((prev) => prev.filter((m) => (m.id || m.replyId) !== id));
    } catch {
      ctx.cache.enqueue({ kind: 'ack', from: target, agentToken, id });
      setStatus('offline — ack queued for Queue retry');
    }
  };

  // Section rows by brief thread: batch, else reply chain, else the message.
  const rows = [];
  const seenKeys = {};
  items.forEach((m) => {
    const k = m.batch || m.replyTo || m.id;
    if (!seenKeys[k]) { seenKeys[k] = true; rows.push({ t: 'h', k, m }); }
    rows.push({ t: 'm', k: String(m.id || m.replyId), m });
  });

  return (
    <View style={S.screen}>
      <HeaderBar title="Activity Feed" statusText={status} navigation={navigation} rightTitle="Sync" onRightPress={load} />
      <View style={S.body}>
        <View style={S.row}>
          <TextInput style={[S.input, { flex: 1 }]} value={agent} onChangeText={setAgent} placeholder="agent (default: mobile)" placeholderTextColor={T.textSubtle} />
          <TouchableOpacity style={S.btnPrimary} onPress={load}><Text style={S.btnPrimaryText}>Load</Text></TouchableOpacity>
        </View>
        {alert ? (
          <View style={S.alertBox}>
            <Text style={S.alertTitle}>{alert.title}</Text>
            <Text style={S.cardSub} numberOfLines={2}>{alert.body}</Text>
            <TouchableOpacity onPress={() => setAlert(null)}><Text style={S.dismiss}>Dismiss</Text></TouchableOpacity>
          </View>
        ) : null}
        <FlatList
          data={rows}
          keyExtractor={(r) => r.t + ':' + String(r.k)}
          ListEmptyComponent={<Text style={S.empty}>All caught up! No unacked messages in inbox.</Text>}
          renderItem={({ item }) => (item.t === 'h' ? (
            <Text style={styles.briefHead}>{item.m.subject || '(no subject)'} · {item.m.from || ''}</Text>
          ) : (
            <View style={[S.card, styles.msgCard]}>
              <View style={styles.msgHead}>
                <Text style={styles.senderPill}>@{item.m.from || 'agent'}</Text>
                <Text style={S.textMuted}>{kindOf(item.m)}{item.m.at ? ' · ' + item.m.at.slice(11, 19) : ''}</Text>
              </View>
              <Text style={S.cardTitle}>{item.m.subject || '(no subject)'}</Text>
              <Text style={S.cardSub} numberOfLines={3}>{item.m.body || item.m.digest || item.m.head || ''}</Text>
              <View style={styles.actionRow}>
                <TouchableOpacity style={[S.btnSuccess, styles.ackBtn]} onPress={() => ack(item.m.id || item.m.replyId)}>
                  <IconCheck size={14} color={T.emerald} />
                  <Text style={[S.btnText, { color: T.emerald }]}>Ack Message</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        />
      </View>
      <BottomNav currentRoute={ROUTES.Triage} navigation={navigation} />
    </View>
  );
}

