-- ============================================================
-- Supabase Auth integration: FK + trigger + RLS
-- ============================================================
-- Migration scritta a mano (drizzle-kit non gestisce trigger/RLS).
-- Mantiene public.users 1:1 con auth.users e applica policy di
-- sicurezza coerenti con i ruoli applicativi (admin/operator/viewer).
--
-- Decisione architetturale (scenario 2 - multi-user, no per-retailer scoping):
--   - Tutti gli utenti che fanno login sono operatori SoKeto.
--   - I retailers NON hanno login propri (sono solo anagrafica).
--   - Default role per nuovi signup: 'operator'. Promozione ad 'admin'
--     manuale via script create-admin.ts o via UI /settings/team.

-- ============================================================
-- 1. FK public.users.id  ->  auth.users.id
-- ============================================================
ALTER TABLE "users"
  ADD CONSTRAINT "users_id_fkey"
  FOREIGN KEY ("id")
  REFERENCES "auth"."users"("id")
  ON DELETE CASCADE;
--> statement-breakpoint

-- ============================================================
-- 2. Trigger: ad ogni INSERT su auth.users crea la riga corrispondente
--    in public.users con role default 'operator'.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, email, name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
--> statement-breakpoint
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
--> statement-breakpoint

-- ============================================================
-- 3. Helper function: ruolo dell'utente corrente (cacheato per tx).
--    SECURITY DEFINER per non innescare ricorsione RLS su users.
-- ============================================================
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role::text FROM public.users WHERE id = auth.uid();
$$;
--> statement-breakpoint

-- ============================================================
-- 4. RLS — public.users
-- ============================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "users_select_self_or_admin" ON public.users
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.current_user_role() = 'admin');
--> statement-breakpoint

CREATE POLICY "users_update_self_or_admin" ON public.users
  FOR UPDATE TO authenticated
  USING (auth.uid() = id OR public.current_user_role() = 'admin')
  WITH CHECK (auth.uid() = id OR public.current_user_role() = 'admin');
--> statement-breakpoint

CREATE POLICY "users_insert_admin" ON public.users
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_role() = 'admin');
--> statement-breakpoint

CREATE POLICY "users_delete_admin" ON public.users
  FOR DELETE TO authenticated
  USING (public.current_user_role() = 'admin');
--> statement-breakpoint

-- ============================================================
-- 5. RLS — tabelle applicative
--    SELECT: qualsiasi utente autenticato (admin/operator/viewer)
--    INSERT/UPDATE/DELETE: admin o operator (viewer solo lettura)
-- ============================================================

-- retailers
ALTER TABLE public.retailers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "retailers_select_authenticated" ON public.retailers
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "retailers_modify_admin_operator" ON public.retailers
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (public.current_user_role() IN ('admin', 'operator'));
--> statement-breakpoint

-- products
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "products_select_authenticated" ON public.products
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "products_modify_admin_operator" ON public.products
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (public.current_user_role() IN ('admin', 'operator'));
--> statement-breakpoint

-- inventory
ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "inventory_select_authenticated" ON public.inventory
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "inventory_modify_admin_operator" ON public.inventory
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (public.current_user_role() IN ('admin', 'operator'));
--> statement-breakpoint

-- stockMovements
ALTER TABLE public."stockMovements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "stockMovements_select_authenticated" ON public."stockMovements"
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "stockMovements_modify_admin_operator" ON public."stockMovements"
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (public.current_user_role() IN ('admin', 'operator'));
--> statement-breakpoint

-- alerts
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "alerts_select_authenticated" ON public.alerts
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "alerts_modify_admin_operator" ON public.alerts
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (public.current_user_role() IN ('admin', 'operator'));
--> statement-breakpoint

-- syncLogs
ALTER TABLE public."syncLogs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "syncLogs_select_authenticated" ON public."syncLogs"
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "syncLogs_modify_admin_operator" ON public."syncLogs"
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (public.current_user_role() IN ('admin', 'operator'));
