import { Book, HelpCircle, MessageSquare, ShoppingCart, Users } from "lucide-react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogTitle
} from "@/components/ui/dialog";

interface QuestionModalProps {
  isOpen?: boolean;
  onClose?: () => void;
  trigger?: React.ReactNode;
}

const helpOptions = [
  {
    id: "documentation",
    icon: <Book className="h-8 w-8 text-indigo-500" />,
    label: "Documentation",
    href: "/docs"
  },
  {
    id: "support",
    icon: <HelpCircle className="h-8 w-8 text-blue-500" />,
    label: "Support",
    href: "/support"
  },
  {
    id: "feature-request",
    icon: <MessageSquare className="h-8 w-8 text-green-500" />,
    label: "Feature request",
    href: "/feature-request"
  },
  {
    id: "contact-sales",
    icon: <ShoppingCart className="h-8 w-8 text-amber-500" />,
    label: "Contact sales",
    href: "/contact-sales"
  },
  {
    id: "discord",
    icon: <Users className="h-8 w-8 text-purple-500" />,
    label: "Discord",
    href: "https://discord.gg/mantlz"
  }
];

export function QuestionModal({ isOpen, onClose, trigger }: QuestionModalProps) {
  const handleOpenChange = (open: boolean) => {
    if (!open && onClose) {
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="max-w-xl border-2 border-zinc-200 shadow-lg dark:border-zinc-800 p-0 overflow-hidden border-none">
        <div className="p-8 pt-10">
          <DialogTitle className="text-xl font-semibold text-center mb-2">
            How can we help?
          </DialogTitle>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center mt-2 mb-8">
            Choose an option based on your needs.
          </p>
          
          <div className="grid grid-cols-2 gap-6">
            {helpOptions.slice(0, 2).map((option) => (
              <Link 
                key={option.id}
                href={option.href}
                className="flex flex-col items-center justify-center p-6 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-all shadow-sm hover:shadow"
                onClick={() => onClose?.()}
              >
                <div className="flex justify-center items-center mb-3">
                  {option.icon}
                </div>
                <span className="text-sm font-medium">{option.label}</span>
              </Link>
            ))}
          </div>
          
          <div className="grid grid-cols-3 gap-4 mt-6">
            {helpOptions.slice(2).map((option) => (
              <Link 
                key={option.id}
                href={option.href}
                className="flex flex-col items-center justify-center p-4 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-all shadow-sm hover:shadow"
                onClick={() => onClose?.()}
              >
                <div className="flex justify-center items-center mb-2">
                  {option.icon}
                </div>
                <span className="text-xs font-medium text-center">{option.label}</span>
              </Link>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
} 