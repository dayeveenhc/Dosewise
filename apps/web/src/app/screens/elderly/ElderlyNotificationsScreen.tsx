import { MessageSquare, User } from "lucide-react";
import type { Message } from "../../types";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";

export function ElderlyNotificationsScreen({ careMessages }: { careMessages: Message[] }) {
  const { language } = useLanguage();
  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex-1 overflow-y-auto scrollbar-none px-4 pb-28 pt-3 space-y-3">
        <p className="text-sm text-muted-foreground">{t(language, "notifications.header")}</p>
        {careMessages.length === 0 ? (
          <div className="bg-card rounded-2xl border border-border p-6 text-center">
            <MessageSquare size={28} className="text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">{t(language, "notifications.empty")}</p>
          </div>
        ) : careMessages.map(msg => (
          <div key={msg.id} className="bg-card rounded-2xl border border-border p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                <User size={14} className="text-primary" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-foreground">{msg.author}</p>
                <p className="text-xs text-muted-foreground">{msg.role}</p>
              </div>
              <p className="text-xs text-muted-foreground">{msg.time}</p>
            </div>
            <p className="text-[15px] text-foreground leading-relaxed">{msg.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
