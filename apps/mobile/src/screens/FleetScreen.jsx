// CrewBus M5 Fleet screen — worker cards with two-tap safe kill. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { useStyles } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { ROUTES } from '../navigation/routes.js';

export function FleetScreen({ ctx, navigation }) {
  const { T, S } = useStyles();
  const styles = React.useMemo(() => StyleSheet.create({
  workerCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, marginVertical: 4 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  }), [T]);
  const [agent] = React.useState('mobile');
  const [agentToken] = React.useState('');
  const [workers, setWorkers] = React.useState([]);
  const [armed, setArmed] = React.useState(null);
  const [status, setStatus] = React.useState('Fleet monitoring ready.');

  const currentApi = () => {
    const route = ctx.connection.getState().route;
    if (!route) throw new Error('no route connected — connect in Hub');
    return ctx.apiFor(route);
  };

  const load = async () => {
    try {
      const data = await currentApi().fetchFleet();
      const list = Array.isArray(data) ? data : data.workers || data.items || [];
      setWorkers(list);
      setStatus(`${list.length} worker${list.length === 1 ? '' : 's'} reported`);
    } catch { setStatus('offline — could not reach relay fleet'); }
  };

  React.useEffect(() => { load().catch(() => null); }, []);

  const kill = async (name) => {
    if (armed !== name) { setArmed(name); setStatus(`Tap Confirm Kill to terminate ${name}`); return; }
    setArmed(null);
    try {
      await currentApi().kill({ from: agent.trim(), agentToken, to: [name] });
      setWorkers((prev) => prev.filter((w) => (w.name || w) !== name));
      setStatus(`Killed worker ${name}`);
    } catch {
      ctx.cache.enqueue({ kind: 'kill', from: agent.trim(), agentToken, to: [name] });
      setStatus('offline — kill queued for Queue retry');
    }
  };

  return (
    <View style={S.screen}>
      <HeaderBar title="Fleet & Workers" statusText={status} navigation={navigation} rightTitle="Refresh" onRightPress={load} />
      <View style={S.body}>
        <FlatList
          data={workers}
          keyExtractor={(w, i) => String((w && w.name) || w || i)}
          ListEmptyComponent={<Text style={S.empty}>No workers running. Launch new workers from the Launch tab.</Text>}
          renderItem={({ item }) => {
            const name = String((item && item.name) || item);
            const alive = item && (item.alive === true || item.status === 'running');
            const isArmed = armed === name;
            return (
              <View style={[S.card, styles.workerCard]}>
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={S.row}>
                    <View style={[styles.dot, { backgroundColor: alive ? T.emerald : T.textSubtle }]} />
                    <Text style={S.cardTitle}>{name}</Text>
                  </View>
                  <Text style={S.textMuted}>{item && item.pid ? `PID: ${item.pid}` : 'detached'} · {item && item.driver ? item.driver : 'worker'}</Text>
                </View>
                <TouchableOpacity style={isArmed ? S.btnDanger : S.btnSecondary} onPress={() => kill(name)}>
                  <Text style={[S.btnText, isArmed && { color: T.rose }]}>{isArmed ? 'Confirm Kill' : 'Kill'}</Text>
                </TouchableOpacity>
              </View>
            );
          }}
        />
      </View>
      <BottomNav currentRoute={ROUTES.Fleet} navigation={navigation} />
    </View>
  );
}

