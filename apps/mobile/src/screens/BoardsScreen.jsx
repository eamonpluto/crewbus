// CrewBus M5 Boards screen — route/env picker and board snapshot. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { useStyles } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { IconStar, IconZap } from '../components/Icons.jsx';
import { ROUTES } from '../navigation/routes.js';

export function BoardsScreen({ ctx, navigation }) {
  const { T, S } = useStyles();
  const styles = React.useMemo(() => StyleSheet.create({
  routeCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 10 },
  routeText: { color: T.text, fontSize: 13, fontWeight: '600' },
  prefWrap: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  prefTag: { color: T.amber, fontSize: 11 },
  btnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  }), [T]);
  const [routes, setRoutes] = React.useState([]);
  const [board, setBoard] = React.useState(null);
  const [status, setStatus] = React.useState('Add or select a relay route.');
  const [draft, setDraft] = React.useState('');
  const [conn, setConn] = React.useState('unknown');

  const refreshConn = () => setConn(ctx.connection.getState().state);
  const addRoute = () => {
    const r = draft.trim();
    if (!r) return;
    setRoutes((prev) => (prev.includes(r) ? prev : [...prev, r]));
    setDraft('');
  };

  const useRoute = async (route) => {
    setStatus(`probing ${route}…`);
    try {
      const api = ctx.apiFor(route);
      await api.fetchHealth();
      const snapshot = await api.fetchBoard();
      const advertised = await api.fetchRoutes().catch(() => null);
      const hints = (advertised && (advertised.advertisedRoutes || advertised.routes)) || [];
      setRoutes((prev) => [...new Set([...prev, ...hints])]);
      ctx.connection.updateRoutes([...new Set([...routes, route, ...hints])]);
      await ctx.connection.retryNow();
      setBoard(snapshot);
      setStatus(`connected: ${route}`);
    } catch (e) {
      setStatus(`unreachable: ${String((e && e.message) || e)}`);
    }
    refreshConn();
  };

  const preferred = ctx.connection.learned.preferred(routes);
  // Liveness, not presence-by-count: board.workers lists every pid-bearing
  // worker, live or dead — only w.alive === true counts as active.
  const workerList = board && Array.isArray(board.workers) ? board.workers : [];
  const liveCount = workerList.filter((w) => w && w.alive === true).length;

  return (
    <View style={S.screen}>
      <HeaderBar title="Relay Hub" statusText={status} connState={conn} navigation={navigation} />
      <View style={S.body}>
        <View style={S.row}>
          <TextInput style={[S.input, { flex: 1 }]} value={draft} onChangeText={setDraft} placeholder="https://relay:port" placeholderTextColor={T.textSubtle} />
          <TouchableOpacity style={S.btnPrimary} onPress={addRoute}><Text style={S.btnPrimaryText}>+ Add</Text></TouchableOpacity>
        </View>
        <FlatList
          data={routes}
          keyExtractor={(r) => r}
          ListEmptyComponent={<Text style={S.empty}>No relay routes yet. Scan QR or enter URL above.</Text>}
          renderItem={({ item }) => (
            <View style={[S.card, styles.routeCard]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.routeText} numberOfLines={1}>{item}</Text>
                {item === preferred ? (
                  <View style={styles.prefWrap}>
                    <IconStar size={11} color={T.amber} />
                    <Text style={styles.prefTag}>Preferred Learned Route</Text>
                  </View>
                ) : null}
              </View>
              <TouchableOpacity style={S.btnSecondary} onPress={() => useRoute(item)}>
                <Text style={S.btnText}>Connect</Text>
              </TouchableOpacity>
            </View>
          )}
        />
        {board ? (
          <View style={S.card}>
            <Text style={S.cardTitle}>Board: {String(board.name || 'Local Board')}</Text>
            <Text style={S.cardSub}>{board.workers ? `${liveCount} of ${workerList.length || Object.keys(board.workers).length} workers live` : 'Online'}</Text>
            <TouchableOpacity style={[S.btnSecondary, styles.btnRow]} onPress={() => navigation.navigate(ROUTES.Briefs)}>
              <Text style={S.btnText}>View Briefs →</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        <TouchableOpacity style={[S.btnSecondary, styles.btnRow]} onPress={() => { ctx.connection.retryNow(); refreshConn(); }}>
          <IconZap size={14} color={T.text} />
          <Text style={S.btnText}>Re-probe Connection</Text>
        </TouchableOpacity>
      </View>
      <BottomNav currentRoute={ROUTES.Boards} navigation={navigation} badgeQueue={ctx.cache.pending().length} />
    </View>
  );
}

