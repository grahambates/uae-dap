/** Type of the message packet */
export enum PacketType {
  ERROR,
  REGISTER,
  MEMORY,
  SEGMENT,
  END,
  STOP,
  UNKNOWN,
  OK,
  PLUS,
  FRAME,
  MINUS,
  OUTPUT,
  QTSTATUS,
}

/** Packet sent by the debugging server */
export class Packet {
  private notification = false;

  constructor(private type: PacketType, private message: string) {}

  public setNotification(isNotification: boolean) {
    this.notification = isNotification;
  }

  public isNotification(): boolean {
    return this.notification;
  }

  public getType(): PacketType {
    return this.type;
  }
  public getMessage(): string {
    return this.message;
  }

  /**
   * Parses the data received.
   * @param data Data to parse
   */
  public static parseData(data: Buffer): Packet[] {
    const parsedData = new Array<Packet>();
    if (data) {
      let s = data.toString();
      if (s.startsWith("+")) {
        parsedData.push(new Packet(PacketType.PLUS, "+"));
        if (s.length > 1) {
          s = s.substring(1);
        }
      }
      if (s.length > 0) {
        const messageRegexp = /\$([^$]*)#[\da-f]{2}/gi;
        if (s.startsWith("+")) {
          s = s.substring(1);
        }
        let match = messageRegexp.exec(s);
        while (match) {
          let message = Packet.extractPacket(match[1]);
          let isNotification = false;
          if (message.startsWith("%Stop")) {
            isNotification = true;
            message = message.replace("%Stop:", "");
          }
          const packet = new Packet(Packet.parseType(message), message);
          packet.setNotification(isNotification);
          parsedData.push(packet);
          match = messageRegexp.exec(s);
        }
      }
      // TODO: check the checksum and ask to repeat the message if it is not verified
    }
    return parsedData;
  }

  /**
   * Extracts the contents of the packet
   * @param message Packet message to parse
   */
  protected static extractPacket(message: string): string {
    if (message.startsWith("$")) {
      const pos = message.indexOf("#");
      if (pos > 0) {
        return message.substring(1, pos);
      }
    }
    return message;
  }

  /**
   * Parses the type of the packet
   * @param message packet message to parse
   */
  public static parseType(message: string): PacketType {
    if (message.startsWith("OK")) {
      return PacketType.OK;
    } else if (message.startsWith("+")) {
      return PacketType.PLUS;
    } else if (message.startsWith("AS")) {
      return PacketType.SEGMENT;
    } else if (message.startsWith("E")) {
      return PacketType.ERROR;
    } else if (
      message.startsWith("S") ||
      (message.startsWith("T") && !message.startsWith("Te"))
    ) {
      if (message.includes("tframes")) {
        return PacketType.QTSTATUS;
      }
      return PacketType.STOP;
    } else if (message.startsWith("W")) {
      return PacketType.END;
    } else if (message.startsWith("F")) {
      return PacketType.FRAME;
    } else if (message === "-") {
      return PacketType.MINUS;
    } else if (message.startsWith("O")) {
      return PacketType.OUTPUT;
    }
    return PacketType.UNKNOWN;
  }
}
