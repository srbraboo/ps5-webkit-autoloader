// First payload: stop before the kernel exploit or autoload when an ELF loader
// already accepts connections on loopback. The runner has prepared WebKit/ROP,
// so this can probe a raw TCP socket without sending any data or needing krw.
const NR = { SOCKET: 0x61, CONNECT: 0x62, CLOSE: 6 };

return async function (api) {
  let fd = -1;
  try {
    const addr = api.p.malloc(16, 1);
    for (let i = 0; i < 16; i++) api.p.write1(addr.add32(i), 0);
    // sockaddr_in: length, AF_INET, network-order port 9021, 127.0.0.1.
    [16, 2, 0x23, 0x3d, 127, 0, 0, 1].forEach((v, i) => api.p.write1(addr.add32(i), v));

    const socket = await api.chain.syscall(NR.SOCKET, 2, 1, 0);
    if ((socket.low | 0) === -1) throw new Error('Could not create the ELF loader probe socket.');
    fd = socket.low | 0;
    const connected = await api.chain.syscall(NR.CONNECT, fd, addr, 16);
    if ((connected.low | 0) === 0) {
      api.stopQueue('ELF loader is already accepting connections on 127.0.0.1:9021');
      await api.log('ELF loader is already running. Skipping the kernel exploit and autoload.', 'success');
    } else {
      await api.log('No ELF loader is accepting connections on port 9021. Continuing.', 'info');
    }
  } catch (error) {
    // An unexpected probe failure is not evidence that it is safe to exploit
    // again. The queue normally continues on errors, so stop it explicitly.
    api.stopQueue('Could not check whether the ELF loader is already running');
    throw error;
  } finally {
    if (fd >= 0) {
      try {
        const closed = await api.chain.syscall(NR.CLOSE, fd);
        if ((closed.low | 0) === -1) throw new Error('Could not close the ELF loader probe socket.');
      } catch (error) {
        api.stopQueue('Could not close the ELF loader probe socket');
        throw error;
      }
    }
  }
};
