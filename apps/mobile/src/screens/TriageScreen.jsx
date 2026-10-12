// CrewBus M5 Triage screen — unacked inbox grouped by brief, 1-tap ack. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { THEME, STYLES } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { IconCheck } from '../components/Icons.jsx';
import { ROUTES } from '../navigation/routes.js';
import { startWatch, buzz } from '../lib/watch.js';
const kindOf = (m) => (!m.replyTo ? 'note' : (m.checkpoint === true ? 'checkpoint' : 'final'));
export function TriageScreen({ ctx, navigation }) {
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
    <View style={STYLES.screen}>
      <HeaderBar title="Activity Feed" statusText={status} navigation={navigation} rightTitle="Sync" onRightPress={load} />
      <View style={STYLES.body}>
        <View style={STYLES.row}>
          <TextInput style={[STYLES.input, { flex: 1 }]} value={agent} onChangeText={setAgent} placeholder="agent (default: mobile)" placeholderTextColor={THEME.textSubtle} />
          <TouchableOpacity style={STYLES.btnPrimary} onPress={load}><Text style={STYLES.btnText}>Load</Text></TouchableOpacity>
        </View>
        {alert ? (
          <View style={styles.alertBox}>
            <Text style={styles.alertTitle}>{alert.title}</Text>
            <Text style={STYLES.cardSub} numberOfLines={2}>{alert.body}</Text>
            <TouchableOpacity onPress={() => setAlert(null)}><Text style={styles.dismiss}>Dismiss</Text></TouchableOpacity>
          </View>
        ) : null}
        <FlatList
          data={rows}
          keyExtractor={(r) => r.t + ':' + String(r.k)}
          ListEmptyComponent={<Text style={styles.empty}>All caught up! No unacked messages in inbox.</Text>}
          renderItem={({ item }) => (item.t === 'h' ? (
            <Text style={styles.briefHead}>{item.m.subject || '(no subject)'} · {item.m.from || ''}</Text>
          ) : (
            <View style={[STYLES.card, styles.msgCard]}>
              <View style={styles.msgHead}>
                <Text style={styles.senderPill}>@{item.m.from || 'agent'}</Text>
                <Text style={STYLES.textMuted}>{kindOf(item.m)}{item.m.at ? ' · ' + item.m.at.slice(11, 19) : ''}</Text>
              </View>
              <Text style={STYLES.cardTitle}>{item.m.subject || '(no subject)'}</Text>
              <Text style={STYLES.cardSub} numberOfLines={3}>{item.m.body || item.m.digest || item.m.head || ''}</Text>
              <View style={styles.actionRow}>
                <TouchableOpacity style={[STYLES.btnSuccess, styles.ackBtn]} onPress={() => ack(item.m.id || item.m.replyId)}>
                  <IconCheck size={14} color={THEME.emerald} />
                  <Text style={[STYLES.btnText, { color: THEME.emerald }]}>Ack Message</Text>
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

const styles = StyleSheet.create({
  msgCard: { padding: 12, gap: 6, marginVertical: 4 },
  msgHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  senderPill: { backgroundColor: 'rgba(99, 102, 241, 0.15)', color: THEME.primaryLight, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, fontSize: 11, fontWeight: '700' },
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 4 },
  ackBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  briefHead: { color: THEME.text, fontSize: 12, fontWeight: '700', marginTop: 10, marginBottom: 2 },
  alertBox: { borderWidth: 1, borderColor: THEME.amber, borderRadius: 8, padding: 10, marginTop: 8, gap: 4 },
  alertTitle: { color: THEME.amber, fontSize: 13, fontWeight: '700' },
  dismiss: { color: THEME.textSubtle, fontSize: 12, textAlign: 'right' },
  empty: { color: THEME.textSubtle, textAlign: 'center', marginTop: 40, fontSize: 13 },
});
