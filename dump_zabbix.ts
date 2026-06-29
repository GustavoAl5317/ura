import { config } from './src/config';
import { ZabbixClient } from './src/integrations/zabbix';

async function run() {
  console.log('Conectando ao Zabbix em:', config.zabbix.baseUrl);
  const zabbix = new ZabbixClient();
  
  try {
    // Busca os 100 problemas mais recentes de qualquer tipo (sem filtro de nome)
    const problems = await (zabbix as any).call('problem.get', {
      output: ['eventid', 'name', 'severity', 'clock'],
      selectHosts: ['hostid', 'host', 'name'],
      suppressed: false,
      sortfield: 'eventid',
      sortorder: 'DESC',
      limit: 100,
    });

    console.log(`\nForam encontrados ${problems.length} problemas ativos recentes no Zabbix:\n`);
    
    problems.forEach((p: any) => {
      const hosts = p.hosts?.map((h: any) => h.host).join(', ');
      console.log(`- ALERTA: "${p.name}"`);
      console.log(`  Host: ${hosts}`);
      console.log(`  ID: ${p.eventid}\n`);
    });

  } catch (err: any) {
    console.error('Erro ao buscar alertas no Zabbix:', err.message);
  }
}

run();
