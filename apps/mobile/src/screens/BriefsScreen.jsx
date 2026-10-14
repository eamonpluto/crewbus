// CrewBus M5 Briefs screen — one row per fan-out; tap for its gathered thread. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { useStyles } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { ROUTES } from '../navigation/routes.js';

export function BriefsScreen({ ctx, navigation }) {
  const { T, S } = useStyles();
  const styles = React.useMemo(() => StyleSheet.create({
  rowCard: { padding: 12, gap: 6, marginVertical: 4 },
  msgBox: { marginTop: 6, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: T.border },
  msgHead: { color: T.primaryLight, fontSize: 11, fontWeight: '700', marginBottom: 2 },
  }), [T]);
  const [rows, setRows] = React.useState([]);
  const [openId, setOpenId] = React.useState(null);
  const [thread, setThread] = React.useState([]);
  const [status, setStatus] = React.useState('Load briefs from the Hub board.');

  const currentApi = () => {
    const route = ctx.connection.getState().route;
    if (!route) throw new Error('no route connected — connect in Hub');
    return ctx.apiFor(route);
  };

  const load = async () => {
    try {
      const board = await currentApi().fetchBoard();
      const list = Array.isArray(board.briefs) ? board.briefs : [];
      setRows(list);
      setStatus(`${list.length} active brief${list.length === 1 ? '' : 's'}`);
    } catch { setStatus('offline — could not reach board'); }
  };

  React.useEffect(() => { load().catch(() => null); }, []);

  const open = async (batch) => {
    if (openId === batch) { setOpenId(null); return; }
    setOpenId(batch);
    try {
      const g = await currentApi().fetchGather(batch);
      setThread(Array.isArray(g.items) ? g.items : []);
    } catch { setThread([]); }
  };

  return (
    <View style={S.screen}>
      <HeaderBar title="Briefs" statusText={status} navigation={navigation} rightTitle="Refresh" onRightPress={load} />
      <View style={S.body}>
        <FlatList
          data={rows}
          keyExtractor={(b) => String(b.batch)}
          ListEmptyComponent={<Text style={S.empty}>No briefs yet. Launch work from the Launch tab.</Text>}
          renderItem={({ item }) => (
            <View style={[S.card, styles.rowCard]}>
              <TouchableOpacity onPress={() => open(item.batch)}>
                <Text style={S.cardTitle}>{item.subject || '(no subject)'}</Text>
                <Text style={S.textMuted}>{(item.workers || []).length} workers · {item.checkpointCount || 0} checkpoints · {item.finalCount || 0} finals · {item.ackedFinals || 0} acked</Text>
              </TouchableOpacity>
              {openId === item.batch ? thread.map((m) => (
                <View key={String(m.id)} style={styles.msgBox}>
                  <Text style={styles.msgHead}>{!m.replyTo ? 'brief' : (m.checkpoint ? 'checkpoint' : 'final' + (m.acked ? ' ✓' : ''))} · @{m.from || '?'}</Text>
                  <Text style={S.cardSub} numberOfLines={4}>{m.body || ''}</Text>
                </View>
              )) : null}
            </View>
          )}
        />
      </View>
      <BottomNav currentRoute={ROUTES.Briefs} navigation={navigation} />
    </View>
  );
}

