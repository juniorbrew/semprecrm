-- ============================================================
-- 050_fix_profiles_privilege_columns.sql — trava as colunas de privilégio
--   do profile (portado do wacrm, GHSA-fg5p-2qc3-jmxr, migration 031 dele)
--
-- O problema: a policy profiles_update (017) só confere auth.uid() = user_id.
-- A RLS limita QUAIS LINHAS a pessoa altera, não QUAIS COLUNAS — e
-- account_role / account_id moram no profile e são a fonte de verdade de
-- is_account_member(). Pelo navegador (role authenticated), um visualizador
-- podia se promover a dono ou se mudar para a conta de outro cliente:
--   UPDATE profiles SET account_role = 'owner' WHERE user_id = auth.uid();
--
-- A correção: gatilho BEFORE UPDATE que recusa mudar account_role /
-- account_id quando quem chama é o authenticated. Quem escreve de verdade
-- não é afetado: as RPCs de membros/convites (018/019), o cadastro de conta
-- (042/043) e o painel da plataforma são SECURITY DEFINER (current_user =
-- postgres) ou rodam como service_role. Edições do próprio perfil que não
-- mexem nessas duas colunas (nome, avatar, notificações, disponibilidade)
-- passam normalmente.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role and account_id cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_profile_privilege_columns ON public.profiles;
CREATE TRIGGER enforce_profile_privilege_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_privilege_columns();
